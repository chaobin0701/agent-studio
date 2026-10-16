import { LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { keySchema, skillSchema, type SkillSpec } from "./resource.types";
import { skillBundleSchema, skillResourcesSchema } from "./skill-resources";

export type SkillDiagnostic = {
  field: string;
  severity: "warning" | "error";
  message: string;
};
const supported = new Set([
  "name",
  "title",
  "description",
  "category",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "allowed-kbs",
  "disable-model-invocation",
]);
const unsupportedRuntime = new Set([
  "requires_network",
  "requires-network",
  "context",
  "agent",
  "hooks",
  "disallowed-tools",
  "user-invocable",
  "arguments",
]);
const portableNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const mappingsSchema = z
  .object({
    resourceKey: keySchema.optional(),
    toolMapping: z.record(z.string().max(300), keySchema).optional(),
    knowledgeBaseMapping: z
      .record(z.string().max(300), z.number().int().positive())
      .optional(),
  })
  .strict();

function portableName(key: string) {
  return key
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64)
    .replace(/-$/, "");
}
function list(value: unknown, field: string): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  throw new Error(`${field} 必须是数组或用空格分隔的字符串`);
}

export function skillDocumentDiagnostics(config: SkillSpec): SkillDiagnostic[] {
  const diagnostics: SkillDiagnostic[] = [];
  for (const field of Object.keys(config.extraFrontmatter ?? {})) {
    const blocked = unsupportedRuntime.has(field) || supported.has(field);
    diagnostics.push({
      field,
      severity: blocked ? "error" : "warning",
      message: blocked
        ? `${field} 的运行语义暂不支持；请移除此字段或改为平台支持的配置后再发布。`
        : `${field} 已保留用于往返导入导出，但本系统不会执行此字段。`,
    });
  }
  for (const tool of config.unresolvedTools ?? [])
    diagnostics.push({
      field: "allowed-tools",
      severity: "warning",
      message: `外部工具 ${tool} 仅作为外部声明保留，不会自动授权；实际权限由 Agent 管理。`,
    });
  for (const kb of config.unresolvedKnowledgeBases ?? [])
    diagnostics.push({
      field: "allowed-kbs",
      severity: "warning",
      message: `外部知识库 ${kb} 仅作为外部声明保留，不会自动关联；实际知识库由 Agent 管理。`,
    });
  if (config.description.length > 1024)
    diagnostics.push({
      field: "description",
      severity: "warning",
      message:
        "描述超过通用规范的 1024 字符；现有配置仍可使用，建议缩短以便跨系统导出。",
    });
  if (config.disableModelInvocation)
    diagnostics.push({
      field: "disable-model-invocation",
      severity: "warning",
      message: "此宿主扩展仅保留用于往返导出；本系统默认允许模型选择 Skill。",
    });
  return diagnostics;
}

export function parseSkillDocument(text: string, options: unknown = {}) {
  if (text.length > 75000) throw new Error("Skill 文档不能超过 75000 字符");
  const mapping = mappingsSchema.parse(options);
  const match =
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(
      text.replace(/^\uFEFF/, ""),
    );
  if (!match)
    throw new Error(
      "需要以 --- 开始的 YAML frontmatter，以及结束分隔符后的 Markdown 正文",
    );
  const lineCounter = new LineCounter();
  const doc = parseDocument(match[1], { lineCounter, uniqueKeys: true });
  if (doc.errors.length) {
    const error = doc.errors[0];
    const pos = lineCounter.linePos(error.pos[0]);
    throw new Error(
      `YAML 第 ${pos.line + 1} 行、第 ${pos.col} 列：${error.message.split("\n")[0]}`,
    );
  }
  if (doc.warnings.length)
    throw new Error(
      `YAML 标签或语法暂不支持：${doc.warnings[0].message.split("\n")[0]}`,
    );
  let meta: Record<string, any>;
  try {
    meta = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("YAML 不支持别名或循环引用");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("YAML frontmatter 必须是键值对象");
  for (const field of [
    ...Object.keys(meta),
    ...Object.keys(meta.metadata ?? {}),
  ]) {
    if (["__proto__", "constructor", "prototype"].includes(field))
      throw new Error("YAML 包含不支持的保留字段");
  }
  const documentName = z.string().min(1).max(80).parse(meta.name);
  const legacy = keySchema.safeParse(documentName);
  if (!legacy.success && !portableNameSchema.safeParse(documentName).success)
    throw new Error("name 必须是标准的小写连字符名称，或已有的小写下划线 Key");
  const key =
    mapping.resourceKey ??
    keySchema.parse(
      meta.metadata?.["agent-studio-key"] ??
        (legacy.success
          ? documentName
          : `${/^[a-z]/.test(documentName) ? "" : "skill_"}${documentName.replace(/-/g, "_")}`),
    );
  const allowedTools: string[] = [],
    unresolvedTools: string[] = [];
  for (const entry of list(meta["allowed-tools"], "allowed-tools")) {
    if (typeof entry !== "string")
      throw new Error("allowed-tools 的每个值必须是工具名称");
    const tool = mapping.toolMapping?.[entry] ?? entry;
    if (keySchema.safeParse(tool).success) allowedTools.push(tool);
    else unresolvedTools.push(entry);
  }
  const allowedKnowledgeBaseIds: number[] = [],
    unresolvedKnowledgeBases: string[] = [];
  for (const entry of list(meta["allowed-kbs"], "allowed-kbs")) {
    const id =
      mapping.knowledgeBaseMapping?.[String(entry)] ??
      (typeof entry === "number"
        ? entry
        : /^\d+$/.test(String(entry))
          ? Number(entry)
          : undefined);
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0)
      allowedKnowledgeBaseIds.push(id);
    else if (typeof entry === "string") unresolvedKnowledgeBases.push(entry);
    else throw new Error("allowed-kbs 的每个值必须是知识库 ID");
  }
  const extraFrontmatter = Object.fromEntries(
    Object.entries(meta).filter(([field]) => !supported.has(field)),
  );
  const config = skillSchema.parse({
    description: meta.description,
    category: meta.category ?? meta.metadata?.category ?? "",
    instructions: match[2].trim(),
    allowedTools: [...new Set(allowedTools)],
    allowedKnowledgeBaseIds: [...new Set(allowedKnowledgeBaseIds)],
    disableModelInvocation: z
      .boolean()
      .parse(meta["disable-model-invocation"] ?? false),
    document: text,
    permissionMode: "agent",
    portableName: portableNameSchema.parse(portableName(documentName)),
    ...(meta.license !== undefined ? { license: meta.license } : {}),
    ...(meta.compatibility !== undefined
      ? { compatibility: meta.compatibility }
      : {}),
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
    ...(Object.keys(extraFrontmatter).length ? { extraFrontmatter } : {}),
    ...(unresolvedTools.length
      ? { unresolvedTools: [...new Set(unresolvedTools)] }
      : {}),
    ...(unresolvedKnowledgeBases.length
      ? { unresolvedKnowledgeBases: [...new Set(unresolvedKnowledgeBases)] }
      : {}),
  });
  const diagnostics = skillDocumentDiagnostics(config);
  if (documentName !== config.portableName)
    diagnostics.unshift({
      field: "name",
      severity: "warning",
      message: `旧名称保留为资源 Key；导出标准名称为 ${config.portableName}，不会改动历史绑定。`,
    });
  return {
    key,
    name: String(meta.title ?? meta.metadata?.title ?? documentName),
    config,
    diagnostics,
  };
}

/** Platform mode round-trips bindings; portable mode excludes local KB IDs/policies. */
export function exportSkillDocument(
  key: string,
  name: string,
  config: SkillSpec,
  format: "platform" | "portable" = "platform",
) {
  const parsed = config.document
    ? parseSkillDocument(config.document, { resourceKey: key }).config
    : skillSchema.parse(config);
  if (format === "portable" && parsed.description.length > 1024)
    throw new Error("标准格式的 description 不能超过 1024 字符，请先缩短描述");
  if (parsed.document) {
    if (format === "platform") return parsed.document;
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
      parsed.document.replace(/^\uFEFF/, ""),
    )!;
    const doc = parseDocument(match[1]);
    doc.delete("allowed-kbs");
    doc.delete("disable-model-invocation");
    if (doc.has("metadata")) doc.deleteIn(["metadata", "agent-studio-key"]);
    return `---\n${doc.toString()}---\n${parsed.document.replace(/^\uFEFF/, "").slice(match[0].length)}`;
  }
  const metadata = { ...parsed.metadata };
  delete metadata["agent-studio-key"];
  const meta: Record<string, unknown> = {
    name: parsed.portableName ?? portableName(key),
    description: parsed.description,
    ...(parsed.license !== undefined ? { license: parsed.license } : {}),
    ...(parsed.compatibility !== undefined
      ? { compatibility: parsed.compatibility }
      : {}),
    ...Object.fromEntries(
      Object.entries(parsed.extraFrontmatter ?? {}).filter(
        ([field]) => !supported.has(field),
      ),
    ),
    metadata: {
      ...metadata,
      ...(name !== (parsed.portableName ?? portableName(key))
        ? { title: name }
        : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(format === "platform" ? { "agent-studio-key": key } : {}),
    },
    ...(parsed.allowedTools.length || parsed.unresolvedTools?.length
      ? {
          "allowed-tools": [
            ...parsed.allowedTools,
            ...(parsed.unresolvedTools ?? []),
          ].join(" "),
        }
      : {}),
  };
  if (format === "platform")
    Object.assign(
      meta,
      Object.fromEntries(
        Object.entries(parsed.extraFrontmatter ?? {}).filter(
          ([field]) => !supported.has(field),
        ),
      ),
      {
        "allowed-kbs": [
          ...parsed.allowedKnowledgeBaseIds,
          ...(parsed.unresolvedKnowledgeBases ?? []),
        ],
        "disable-model-invocation": parsed.disableModelInvocation,
      },
    );
  return `---\n${stringify(meta)}---\n\n${parsed.instructions}\n`;
}

/** Canonical source wins over editable projections. Legacy JSON remains readable. */
export function normalizeSkillConfig(
  config: unknown,
  resourceKey: string,
): SkillSpec {
  if (
    config &&
    typeof config === "object" &&
    typeof (config as any).document === "string"
  )
    return skillSchema.parse({
      ...parseSkillDocument((config as any).document, { resourceKey }).config,
      resources: skillResourcesSchema.parse((config as any).resources ?? []),
      // Portable declarations never become local database bindings or grants.
      allowedTools: [],
      allowedKnowledgeBaseIds: [],
    });
  const parsed = skillSchema.parse(config);
  // Old JSON permission fields are retained as document declarations for export,
  // not local resource dependencies. Published database versions are not rewritten.
  const document = parsed.document ??
    (parsed.allowedTools.length || parsed.allowedKnowledgeBaseIds.length || parsed.disableModelInvocation
      ? exportSkillDocument(resourceKey, resourceKey, parsed)
      : undefined);
  return skillSchema.parse({ ...parsed, ...(document ? { document } : {}),
    permissionMode: "agent", allowedTools: [], allowedKnowledgeBaseIds: [] });
}

/** Explicit bounded transport; no archive extraction or implicit permissions. */
export function exportSkillBundle(
  key: string,
  name: string,
  config: SkillSpec,
  format: "platform" | "portable" = "platform",
) {
  const normalized = normalizeSkillConfig(config, key);
  return skillBundleSchema.parse({
    format: "agent-skill-bundle",
    version: 1,
    document: exportSkillDocument(key, name, normalized, format),
    resources: normalized.resources,
  });
}

/** Seed the new editor without moving old runtime restrictions into portable content. */
export function skillEditorDocument(
  key: string,
  name: string,
  config: SkillSpec,
): string {
  if (config.document) return config.document;
  const meta: Record<string, unknown> = {
    name: config.portableName ?? portableName(key),
    description: config.description,
    ...(config.license ? { license: config.license } : {}),
    ...(config.compatibility ? { compatibility: config.compatibility } : {}),
    ...(config.metadata && Object.keys(config.metadata).length
      ? { metadata: config.metadata }
      : {}),
    ...(config.extraFrontmatter ?? {}),
  };
  return `---\n${stringify(meta)}---\n\n${config.instructions}\n`;
}
