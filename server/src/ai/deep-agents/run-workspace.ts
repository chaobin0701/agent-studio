import { StateBackend, type BackendRuntime, type FileData } from "deepagents";
import type { SkillDefinition } from "../skills/skill.types";
import { createHash } from "node:crypto";
import { skillResourcesSchema } from "../../agent-management/skill-resources";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_WORKSPACE_BYTES = 1024 * 1024;
const MAX_WORKSPACE_FILES = 64;
export const WORKSPACE_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
] as const;

export function skillPath(key: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(key))
    throw new TypeError("Invalid mounted Skill key");
  const standard = key.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key);
  const name = standard
    ? key
    : `${key.replace(/[_-]+/gu, "-").slice(0, 50).replace(/-$/u, "")}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  return `/skills/${name}/SKILL.md`;
}

export function skillForPath(
  skills: readonly SkillDefinition[],
  path: string,
): SkillDefinition | undefined {
  return skills.find((skill) => {
    const guide = skillPath(skill.id);
    const root = guide.slice(0, -"SKILL.md".length);
    return (
      path === guide ||
      (skill.resources ?? []).some((file) => path === root + file.path)
    );
  });
}

/** Canonical virtual paths only. This is deliberately not a host path resolver. */
export function validRunPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 240 &&
    path.startsWith("/") &&
    !/[{}()\\\u0000-\u001f~%]/u.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}
export function safeRunPattern(value: unknown): boolean {
  // braces <=3.0.3 has an unpatched recursive-pattern advisory. Do not let
  // model-supplied brace/extglob syntax reach the framework's matcher.
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    !/[{}()\\\u0000-\u001f]/u.test(value)
  );
}

/** Published files have immutable, bounded, host-generated paths/frontmatter. */
export function publishedSkillFiles(
  skills: readonly SkillDefinition[],
): Record<string, FileData> {
  if (skills.length > 64) throw new RangeError("Too many mounted Skills");
  const files: Record<string, FileData> = {};
  const time = new Date().toISOString();
  let bytes = 0;
  for (const skill of skills) {
    const path = skillPath(skill.id);
    if (files[path]) throw new TypeError("Duplicate mounted Skill key");
    const name = path.split("/")[2];
    const resources = skillResourcesSchema.parse(skill.resources ?? []);
    const directory = path.slice(0, -"SKILL.md".length);
    const inventory = resources.length
      ? `\n\n平台只读辅助资料（按需读取；脚本仅供参考，不授予执行权限）：\n${resources.map((file) => `- ${directory}${file.path}`).join("\n")}`
      : "";
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(`平台 Skill Key：${skill.id}。${skill.description}`.slice(0, 1024))}\n---\n${skill.systemInstructions}${inventory}`;
    const size = Buffer.byteLength(content);
    bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_WORKSPACE_BYTES)
      throw new RangeError("Mounted Skill content exceeds limit");
    files[path] = {
      content,
      mimeType: "text/markdown",
      created_at: time,
      modified_at: time,
    };
    for (const resource of resources) {
      const resourcePath = path.slice(0, -"SKILL.md".length) + resource.path;
      bytes += Buffer.byteLength(resource.content);
      if (
        Object.keys(files).length >= MAX_WORKSPACE_FILES ||
        bytes > MAX_WORKSPACE_BYTES
      )
        throw new RangeError("Mounted Skill resources exceed workspace limit");
      files[resourcePath] = {
        content: resource.content,
        mimeType: "text/plain",
        created_at: time,
        modified_at: time,
      };
    }
  }
  if (Object.keys(files).length > MAX_WORKSPACE_FILES)
    throw new RangeError("Too many mounted Skill files");
  return files;
}

/** Ephemeral framework storage, with backend-level immutability and caps even
 * for middleware operations. No StoreBackend, filesystem, shell or execute. */
export class RunWorkspaceBackend extends StateBackend {
  constructor(
    runtime: BackendRuntime,
    private readonly sizes: Map<string, number>,
  ) {
    super(runtime);
  }
  override write(path: string, content: string) {
    const error = this.writeFailure(path, content);
    if (error) return { error };
    const result = super.write(path, content);
    if (!result.error) this.sizes.set(path, Buffer.byteLength(content));
    return result;
  }
  override edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ) {
    if (!validRunPath(path) || !this.mutablePath(path))
      return { error: "Path is read-only or unavailable" };
    const raw = super.readRaw(path);
    if (raw.error || !raw.data) return { error: "File is unavailable" };
    const current = Array.isArray(raw.data.content)
      ? raw.data.content.join("\n")
      : raw.data.content;
    if (typeof current !== "string" || !oldString)
      return { error: "Invalid text edit" };
    const updated = replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString);
    const error = this.writeFailure(path, updated);
    if (error) return { error };
    const result = super.edit(path, oldString, newString, replaceAll);
    if (!result.error) this.sizes.set(path, Buffer.byteLength(updated));
    return result;
  }
  override delete(path: string) {
    if (!validRunPath(path) || !path.startsWith("/workspace/"))
      return { error: "Path is read-only or unavailable" };
    const result = super.delete(path);
    if (!result.error)
      for (const key of this.sizes.keys())
        if (key === path || key.startsWith(`${path}/`)) this.sizes.delete(key);
    return result;
  }
  override uploadFiles(files: Array<[string, Uint8Array]>) {
    return files.map(([path]) => ({
      path,
      error: "permission_denied" as const,
    }));
  }
  override glob(pattern: string, path = "/") {
    if (!safeRunPattern(pattern) || !validRunPath(path))
      return { error: "Unsupported path pattern" };
    return super.glob(pattern, path);
  }
  override grep(
    pattern: string,
    path = "/",
    glob?: string | null,
    maxCount?: number | null,
  ) {
    if (
      pattern.length > 200 ||
      !validRunPath(path) ||
      (glob && !safeRunPattern(glob))
    )
      return { error: "Unsupported search pattern" };
    return super.grep(pattern, path, glob, Math.min(maxCount ?? 100, 100));
  }
  private mutablePath(path: string) {
    return [
      "/workspace/",
      "/tool_results/",
      "/large_tool_results/",
      "/conversation_history/",
    ].some((prefix) => path.startsWith(prefix));
  }
  private writeFailure(path: string, content: string): string | undefined {
    if (!validRunPath(path) || !this.mutablePath(path))
      return "Path is read-only or unavailable";
    const size = Buffer.byteLength(content);
    const total =
      [...this.sizes.values()].reduce((sum, value) => sum + value, 0) -
      (this.sizes.get(path) ?? 0) +
      size;
    if (
      size > MAX_FILE_BYTES ||
      total > MAX_WORKSPACE_BYTES ||
      (!this.sizes.has(path) && this.sizes.size >= MAX_WORKSPACE_FILES)
    )
      return "Run workspace limit exceeded";
    return undefined;
  }
}
