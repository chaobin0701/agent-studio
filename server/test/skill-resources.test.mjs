import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  skillResourcesSchema,
  skillBundleSchema,
  validSkillResourcePath,
} from "../dist/agent-management/skill-resources.js";
import {
  normalizeSkillConfig,
  exportSkillBundle,
} from "../dist/agent-management/skill-document.js";
import { skillSchema } from "../dist/agent-management/resource.types.js";
import {
  publishedSkillFiles,
  skillPath,
  skillForPath,
  RunWorkspaceBackend,
} from "../dist/ai/deep-agents/run-workspace.js";
import { freeze } from "../dist/agent-management/runtime-scope.js";

const document =
  "---\nname: analysis-guide # retained\ndescription: Read supporting material when analysing\n---\n\nRead references/guide.md only when needed.\n";
const resources = [
  { path: "references/guide.md", content: "PRIVATE_REFERENCE" },
  { path: "assets/template.json", content: '{"title":"example"}' },
  { path: "scripts/example.py", content: 'print("NOT_EXECUTED")' },
];
const config = () =>
  normalizeSkillConfig({ document, resources }, "analysis_guide");

test("Skill files reject traversal, host paths, encoded/glob/prototype paths, duplicates and directory conflicts", () => {
  for (const path of [
    "../x",
    "/references/a",
    "references/../x",
    "references/./x",
    "references//a",
    "references/a/",
    "C:\\file",
    "https://example.invalid/a",
    "references/%2e%2e/a",
    "references/{a,b}",
    "references/.env",
    "references/__proto__/a",
    "references/constructor",
    "references/file.",
    "other/file",
    "scripts/a\0.sh",
  ]) {
    assert.equal(validSkillResourcePath(path), false, path);
    assert.equal(
      skillResourcesSchema.safeParse([{ path, content: "x" }]).success,
      false,
      path,
    );
  }
  assert.equal(
    skillResourcesSchema.safeParse([
      { path: "references/A.md", content: "x" },
      { path: "references/a.md", content: "y" },
    ]).success,
    false,
  );
  assert.equal(
    skillResourcesSchema.safeParse([
      { path: "references/folder", content: "x" },
      { path: "references/folder/a.md", content: "y" },
    ]).success,
    false,
  );
  assert.equal(
    skillResourcesSchema.safeParse([
      { path: "references/a", content: "x", executable: true },
    ]).success,
    false,
  );
  assert.deepEqual(skillResourcesSchema.parse(resources), resources);
  const long = `references/${"a".repeat(70)}/${"b".repeat(78)}`;
  assert.equal(long.length, 160);
  assert.equal(validSkillResourcePath(long), true);
  assert.equal(validSkillResourcePath(long + "c"), false);
});

test("limits use UTF-8 bytes, reject binary/unpaired text and bound total files, aggregate and JSON escaping overhead", () => {
  for (const content of ["a\0b", "a\u0001b", "\ud800", "字".repeat(22000)])
    assert.equal(
      skillResourcesSchema.safeParse([{ path: "references/a.md", content }])
        .success,
      false,
    );
  assert.ok(
    skillResourcesSchema.safeParse([
      { path: "references/a.md", content: "a".repeat(65536) },
    ]).success,
  );
  assert.equal(
    skillResourcesSchema.safeParse(
      Array.from({ length: 17 }, (_, i) => ({
        path: `references/${i}.md`,
        content: "",
      })),
    ).success,
    false,
  );
  assert.equal(
    skillResourcesSchema.safeParse(
      Array.from({ length: 4 }, (_, i) => ({
        path: `references/${i}.md`,
        content: "a".repeat(65536),
      })),
    ).success,
    false,
  );
  const overhead = {
    format: "agent-skill-bundle",
    version: 1,
    document: '"'.repeat(75000),
    resources: Array.from({ length: 3 }, (_, i) => ({
      path: `references/${i}.md`,
      content: '"'.repeat(65536),
    })),
  };
  assert.equal(skillBundleSchema.safeParse(overhead).success, false);
  assert.equal(
    skillBundleSchema.safeParse({ ...overhead, version: 2 }).success,
    false,
  );
  assert.equal(
    skillSchema.safeParse({
      ...config(),
      metadata: { huge: "x".repeat(384 * 1024) },
    }).success,
    false,
  );
});

test("canonical document and auxiliary resources round-trip together without granting declared permissions", () => {
  const original = document.replace(
    "description:",
    "allowed-tools: execute_shell\nallowed-kbs: [999]\ndescription:",
  );
  const normalized = normalizeSkillConfig(
    {
      document: original,
      resources,
      instructions: "forged",
      allowedTools: ["execute_shell"],
      allowedKnowledgeBaseIds: [999],
    },
    "legacy_guide",
  );
  assert.equal(normalized.document, original);
  assert.ok(!normalized.instructions.includes("forged"));
  assert.deepEqual(normalized.resources, resources);
  assert.deepEqual(normalized.allowedTools, []);
  assert.deepEqual(normalized.allowedKnowledgeBaseIds, []);
  const bundle = exportSkillBundle(
    "legacy_guide",
    "Guidance",
    normalized,
    "portable",
  );
  assert.match(bundle.document, /# retained/);
  assert.doesNotMatch(bundle.document, /allowed-kbs/);
  assert.deepEqual(
    skillBundleSchema.parse(JSON.parse(JSON.stringify(bundle))).resources,
    resources,
  );
  assert.deepEqual(
    skillSchema.parse({
      description: "Legacy",
      instructions: "Legacy body",
      allowedTools: [],
      allowedKnowledgeBaseIds: [],
    }).resources,
    [],
  );
  assert.throws(() =>
    normalizeSkillConfig(
      { document, resources: [{ path: "/etc/passwd", content: "bad" }] },
      "legacy",
    ),
  );
});

test("legacy source-only snapshots retain the previous limit even when canonical projections duplicate metadata; adding resources applies the new config cap", () => {
  const legacy = `---\nname: legacy-guide\ndescription: Legacy guidance\ncustom-label: ${"字".repeat(66000)}\n---\n\nRead guidance.\n`;
  const normalized = normalizeSkillConfig({ document: legacy }, "legacy_guide");
  assert.ok(Buffer.byteLength(JSON.stringify(normalized)) > 384 * 1024);
  assert.deepEqual(normalized.resources, []);
  const bundle = exportSkillBundle("legacy_guide", "Legacy", normalized);
  assert.equal(bundle.document, legacy);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 384 * 1024);
  assert.throws(
    () =>
      normalizeSkillConfig(
        {
          ...normalized,
          resources: [{ path: "references/a.md", content: "new" }],
        },
        "legacy_guide",
      ),
    /384 KiB/,
  );
});

test("native virtual mounts preserve alias, immutable version/resources and protect all auxiliary paths against direct backend changes", () => {
  const skill = freeze({
    id: "analysis_guide",
    version: "1",
    versionId: 30,
    description: "Analysis",
    systemInstructions: config().instructions,
    resources,
  });
  assert.throws(() => {
    skill.resources[0].content = "changed";
  }, TypeError);
  const files = publishedSkillFiles([skill]),
    root = skillPath(skill.id).replace(/SKILL.md$/, "");
  assert.equal(Object.keys(files).length, 4);
  assert.match(
    files[root + "SKILL.md"].content,
    new RegExp(root + "references/guide.md"),
  );
  assert.ok(!files[root + "SKILL.md"].content.includes("PRIVATE_REFERENCE"));
  const backend = new RunWorkspaceBackend(
    { state: { files }, updateState() {} },
    new Map(),
  );
  for (const resource of resources) {
    const path = root + resource.path;
    assert.equal(files[path].content, resource.content);
    assert.equal(skillForPath([skill], path), skill);
    assert.ok(!backend.read(path).error);
    assert.match(backend.write(path, "tampered").error, /read-only/);
    assert.match(
      backend.edit(path, resource.content, "tampered").error,
      /read-only/,
    );
    assert.match(backend.delete(path).error, /read-only/);
    assert.equal(
      backend.uploadFiles([[path, new TextEncoder().encode("tampered")]])[0]
        .error,
      "permission_denied",
    );
  }
  assert.equal(
    skillForPath([skill], root + "references/missing.md"),
    undefined,
  );
  const longPath = `references/${"a".repeat(70)}/${"b".repeat(78)}`;
  const longest = {
    ...skill,
    id: "a".repeat(64),
    resources: [{ path: longPath, content: "Long but readable" }],
  };
  const longFiles = publishedSkillFiles([longest]);
  const absolute = skillPath(longest.id).replace(/SKILL.md$/, "") + longPath;
  assert.ok(
    absolute.length <= 240,
    "accepted relative paths must remain inside the filesystem gateway path limit",
  );
  assert.equal(
    new RunWorkspaceBackend({ state: { files: longFiles } }, new Map()).readRaw(
      absolute,
    ).data.content,
    "Long but readable",
  );
  assert.throws(
    () =>
      publishedSkillFiles(
        Array.from({ length: 5 }, (_, i) => ({
          ...skill,
          id: `skill-${i}`,
          resources: Array.from({ length: 16 }, (_, n) => ({
            path: `references/${n}.md`,
            content: "x",
          })),
        })),
      ),
    /limit|Too many/,
  );
});
