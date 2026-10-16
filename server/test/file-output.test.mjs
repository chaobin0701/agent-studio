import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {
  FileOutputCollector,
  FileOutputError,
  fileDescriptor,
  validOutputPath,
} from "../dist/artifacts/file-output.js";
import { ExecutionArtifactService } from "../dist/artifacts/execution-artifact.service.js";
import { capabilityOutputs } from "../dist/ai/runtime/capability-output.js";
import { finalFilePaths } from "../dist/ai/deep-agents/final-output.js";
import { agentSchema } from "../dist/agent-management/resource.types.js";

const path = "/workspace/outputs/report.md";
const state = (content = "Generated report") => ({ [path]: { content } });
test("file-output grant is versioned, false by default and never enabled by caller schema or a portable declaration", () => {
  const spec = {
    responsibility: "General",
    promptVersionId: 1,
    modelPlanVersionId: 1,
    toolVersionIds: [],
    skillVersionIds: [],
    knowledgeBaseIds: [],
    runtime: {},
  };
  assert.deepEqual(agentSchema.parse(spec).fileOutputs, { enabled: false });
  assert.deepEqual(
    agentSchema.parse({ ...spec, fileOutputs: { enabled: true } }).fileOutputs,
    { enabled: true },
  );
  assert.equal(
    agentSchema.safeParse({ ...spec, fileOutputs: { enabled: "true" } })
      .success,
    false,
  );
  assert.equal(
    agentSchema.safeParse({
      ...spec,
      fileOutputs: { enabled: true, root: "/etc" },
    }).success,
    false,
  );
  for (const [root, producer] of [
    [false, true],
    [true, false],
  ])
    assert.throws(
      () => new FileOutputCollector(root).capture(1, producer, [path], state()),
      (e) =>
        e instanceof FileOutputError && e.code === "artifact_outputs_disabled",
    );
});
test("only explicit existing output files are selected; resources, history, host/URL paths and malformed text cannot become artifacts", () => {
  for (const bad of [
    "/etc/passwd",
    "/skills/x/SKILL.md",
    "/context/x.json",
    "/documents/1.md",
    "/workspace/scratch.md",
    "/workspace/outputs/../x.md",
    "/workspace/outputs/.env",
    "/workspace/outputs/x.exe",
    "/workspace/outputs/a\n.md",
    "https://example.invalid/x.md",
    "/workspace/outputs/{a,b}.md",
  ]) {
    assert.equal(validOutputPath(bad), false, bad);
    assert.throws(() =>
      new FileOutputCollector(true).capture(1, true, [bad], {
        [bad]: { content: "untrusted" },
      }),
    );
  }
  assert.throws(
    () => new FileOutputCollector(true).capture(1, true, [path], {}),
    /artifact_output_invalid/,
  );
  for (const content of ["\0", "\ud800", new Uint8Array([1, 2])])
    assert.throws(
      () =>
        new FileOutputCollector(true).capture(1, true, [path], state(content)),
      /artifact_output_invalid/,
    );
  const collector = new FileOutputCollector(true);
  assert.throws(() =>
    collector.capture(1, true, [path, "/etc/passwd"], state()),
  );
  const artifacts = collector.capture(1, true, [path], state(["one", "two"]));
  assert.equal(collector.forResult(artifacts)[0].content, "one\ntwo");
  assert.deepEqual(
    collector.forResult([]),
    [],
    "unselected files are discarded",
  );
  assert.doesNotMatch(JSON.stringify(artifacts), /one|two|workspace/);
});
test("file bytes/count are shared across producers, atomic on failure, redacted and absent from returned metadata", () => {
  const collector = new FileOutputCollector(true),
    artifacts = [];
  for (let i = 0; i < 4; i++)
    artifacts.push(
      ...collector.capture(i + 1, true, [path], state("x".repeat(128 * 1024))),
    );
  assert.throws(
    () => collector.capture(5, true, [path], state("x")),
    /artifact_limit_exceeded/,
  );
  assert.equal(collector.forResult(artifacts).length, 4);
  assert.throws(
    () =>
      new FileOutputCollector(true).capture(
        1,
        true,
        [path],
        state("字".repeat(45000)),
      ),
    /artifact_limit_exceeded/,
  );
  const safe = new FileOutputCollector(true),
    result = safe.capture(
      1,
      true,
      [path],
      state("password=SECRET_VALUE\nBearer SECRET_BEARER"),
    );
  assert.doesNotMatch(
    safe.forResult(result)[0].content,
    /SECRET_VALUE|SECRET_BEARER/,
  );
  assert.doesNotMatch(JSON.stringify(result), /content|REDACTED|SECRET/);
  assert.match(result[0].id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(Object.isFrozen(safe.forResult(result)[0]), true);
});
test("a capability cannot forge the reserved file kind; final selection and persistence require exact owned metadata", () => {
  assert.deepEqual(
    capabilityOutputs(
      {
        success: true,
        content: "done",
        artifacts: [
          {
            kind: "execution_file",
            id: "forged",
            data: { content: "private" },
          },
        ],
      },
      "call",
      12000,
    ).artifacts,
    [],
  );
  assert.deepEqual(
    finalFilePaths(JSON.stringify({ answer: "Generated", filePaths: [path] })),
    [path],
  );
  assert.deepEqual(finalFilePaths("Ordinary answer"), []);
  assert.throws(() =>
    finalFilePaths(JSON.stringify({ answer: "Generated", filePaths: [1] })),
  );
  const collector = new FileOutputCollector(true),
    artifacts = collector.capture(1, true, [path], state()),
    files = collector.forResult(artifacts);
  const service = new ExecutionArtifactService({}, {});
  service.assertSelection(artifacts, files);
  assert.throws(() =>
    service.assertSelection(
      [
        {
          ...artifacts[0],
          data: { ...artifacts[0].data, filename: "tampered.md" },
        },
      ],
      files,
    ),
  );
  assert.throws(() =>
    service.assertSelection(artifacts, [{ ...files[0], content: "changed" }]),
  );
  assert.throws(() => service.assertSelection(artifacts, []));
  assert.deepEqual(fileDescriptor(files[0]), artifacts[0]);
});
