import Ajv, { type ErrorObject } from "ajv";
import type { ToolValidationDiagnostics, ToolValidationIssue } from "../ai/tools/tool-validation";
import { z } from "zod";
import { toolArgumentsHash } from "../ai/tools/tool-context";
import type { AgentTool } from "../ai/tools/agent-tool";
import type { AgentArtifact, JsonValue } from "../ai/agent/execution-contract";

export const UI_ARTIFACT_KIND = "generative_ui";
export const uiCatalogSchema = z.object({
  adapter: z.literal("assistant-ui"),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.record(z.string(), z.unknown()),
  components: z.record(z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/), z.object({
    description: z.string().min(1).max(2000),
    props: z.record(z.string(), z.unknown()),
    children: z.boolean(),
  }).strict()),
}).strict();
export type UiCatalog = z.infer<typeof uiCatalogSchema>;

/** A versioned catalog is data, never executable code or a remote schema. */
export function compileUiCatalog(value: unknown) {
  if ((JSON.stringify(value)?.length ?? 0) > 120000) throw new Error("UI 目录超过大小限制");
  const catalog = uiCatalogSchema.parse(value);
  const names = Object.keys(catalog.components);
  if (!names.length || names.length > 30) throw new Error("UI 目录需要 1–30 个组件");
  if (toolArgumentsHash({ parameters: catalog.parameters, components: catalog.components }) !== catalog.version)
    throw new Error("UI 目录摘要不匹配，请重新从展示站导出");
  const inspect = (node: unknown, depth = 0): void => {
    if (depth > 40) throw new Error("UI Schema 嵌套过深");
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (["$id", "$async"].includes(key) || (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))))
        throw new Error("UI Schema 仅支持本地引用");
      inspect(child, depth + 1);
    }
  };
  inspect(catalog);
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const parameters = ajv.compile(catalog.parameters);
  if (catalog.parameters.type !== "object") throw new Error("present Schema 必须是 object");
  const validators = new Map(names.map(name => {
    const spec = catalog.components[name]!;
    if (spec.props.type !== "object" || spec.props.additionalProperties !== false)
      throw new Error("组件属性必须使用封闭 object Schema");
    const properties = spec.props.properties as Record<string, unknown> | undefined;
    if (Object.keys(properties ?? {}).some(key => key.startsWith("_") || key.startsWith("$") || ["children", "__proto__", "constructor", "prototype"].includes(key)))
      throw new Error("组件属性不能覆盖框架保留字段");
    return [name, ajv.compile(spec.props)] as const;
  }));
  // Only published schema fields enter diagnostics, never arbitrary model keys.
  const knownFields = new Set(["_type", "_key", "children"]);
  const collectFields = (schema: unknown): void => {
    if (!schema || typeof schema !== "object") return;
    for (const [key, child] of Object.entries(schema)) {
      if (key === "properties" && child && typeof child === "object")
        Object.keys(child).forEach(field => knownFields.add(field));
      collectFields(child);
    }
  };
  names.forEach(name => collectFields(catalog.components[name]!.props));
  const safeField = (field: unknown) => typeof field === "string" && knownFields.has(field) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field) ? field : undefined;
  const safePath = (path: string) => path.split("/").filter(Boolean).map(part => {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    return `/${/^\d{1,4}$/.test(decoded) ? decoded : safeField(decoded) ?? "*"}`;
  }).join("");
  const diagnose = (tree: unknown): ToolValidationDiagnostics => {
    const issues: ToolValidationIssue[] = [];
    const add = (issue: ToolValidationIssue) => { if (issues.length < 12) issues.push(issue); };
    const ajvIssues = (errors: ErrorObject[] | null | undefined, path: string, component?: string) => {
      for (const error of errors ?? []) {
        const field = safeField(error.params.missingProperty ?? error.params.additionalProperty);
        add({ path: `${path}${safePath(error.instancePath)}`, component, keyword: error.keyword, ...(field ? { field } : {}) });
      }
    };
    let count = 0;
    // Keep the existing tree/limit walk. Ajv alone validates component props.
    const visit = (node: unknown, depth: number, path: string): boolean => {
      if (typeof node === "string") {
        if (node.length > 500) add({ path, keyword: "maxLength" });
        return node.length <= 500;
      }
      if (++count > 80 || depth > 8) { add({ path, keyword: count > 80 ? "node_limit" : "depth_limit" }); return false; }
      if (!node || typeof node !== "object" || Array.isArray(node)) { add({ path, keyword: "type" }); return false; }
      const { _type, _key, children, ...props } = node as Record<string, unknown>;
      if (typeof _type !== "string" || !Object.hasOwn(catalog.components, _type)) { add({ path, field: "_type", keyword: "unknown_component" }); return false; }
      if (_key !== undefined && !(typeof _key === "string" && _key.length <= 100) && !(typeof _key === "number" && Number.isFinite(_key))) {
        add({ path, component: _type, field: "_key", keyword: "type" });
        return false;
      }
      const validator = validators.get(_type)!;
      if (!validator(props)) { ajvIssues(validator.errors, path, _type); return false; }
      if (children === undefined) return true;
      if (!catalog.components[_type]!.children) { add({ path, component: _type, field: "children", keyword: "children_not_allowed" }); return false; }
      if (Array.isArray(children)) {
        if (children.length > 40) { add({ path: `${path}/children`, component: _type, keyword: "maxItems" }); return false; }
        return children.every((child, index) => visit(child, depth + 1, `${path}/children/${index}`));
      }
      return visit(children, depth + 1, `${path}/children`);
    };
    try {
      if ((JSON.stringify(tree)?.length ?? 0) > 6000) add({ path: "", keyword: "size_limit" });
      else if (!tree || typeof tree !== "object" || Array.isArray(tree)) add({ path: "", keyword: "type" });
      else if (visit(tree, 0, "") && !parameters(tree)) ajvIssues(parameters.errors, "");
    } catch { add({ path: "", keyword: "invalid_json_value" }); }
    return { catalogVersion: catalog.version, issues };
  };
  const validate = (tree: unknown): boolean => diagnose(tree).issues.length === 0;
  return { catalog, validate, diagnose };
}

/** Concise hints supplement assistant-ui's merged schema without copying it. */
function componentGuidance(catalog: UiCatalog): string {
  return Object.entries(catalog.components).map(([name, component]) => {
    const fields = Object.keys(component.props.properties ?? {});
    const required = new Set(component.props.required as string[] ?? []);
    const optional = fields.filter(field => !required.has(field));
    return `${name}: 必填 ${[...required].join(", ") || "无"}；可选 ${optional.join(", ") || "无"}；children ${component.children ? "允许" : "禁止"}。${component.description}`;
  }).join("\n");
}

export function makeUiTool(value: unknown): AgentTool {
  const { catalog, validate, diagnose } = compileUiCatalog(value);
  const guidance = componentGuidance(catalog);
  return {
    name: "present",
    description: `通过已注册组件呈现界面；交互能力以组件目录为准，用户提交由前端作为下一轮消息处理，不直接执行工具，也不授予审批权限。将所需组件组合成完整树，成功后无需重复呈现。只填写当前 _type 的属性，参数失败时根据字段路径修正。总量限制：6000 字符、80 节点、深度 8、每组最多 40 个子节点。\n${guidance}`,
    parameters: catalog.parameters,
    inputDiagnostics: diagnose,
    inputSchema: z.unknown().superRefine((tree, ctx) => {
      if (!validate(tree)) ctx.addIssue({ code: "custom", message: "UI 树不符合已发布组件目录或超过限制" });
    }),
    planning: { canBatch: true, isIdempotent: true },
    async execute(tree) {
      if (!validate(tree)) return { success: false, content: "UI 树校验失败", errorCode: "invalid_arguments" };
      const texts: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "string" || typeof value === "number") texts.push(String(value));
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => { if (!key.startsWith("_")) collect(child); });
      };
      collect(tree);
      return {
        success: true, content: "界面已呈现，无需重复调用 present。",
        artifacts: [{ kind: UI_ARTIFACT_KIND, delivery: "immediate", data: {
          adapter: catalog.adapter, catalogVersion: catalog.version, tree: tree as JsonValue,
          fallbackText: texts.join(" · ").slice(0, 2000) || "生成的界面暂不可用",
        } }],
      };
    },
  };
}

export type UiBlock = {
  protocolVersion: 1; runId: string; blockId: string; toolCallId: string;
  adapter: "assistant-ui"; catalogVersion: string; revision: 1; status: "completed";
  tree: JsonValue; fallbackText: string;
};
/** Transport projection of explicitly published artifacts, never arbitrary Tool.data. */
export function uiBlocks(artifacts: readonly AgentArtifact[] | undefined, runId: string): UiBlock[] {
  return (artifacts ?? []).flatMap(artifact => {
    if (artifact.kind !== UI_ARTIFACT_KIND || artifact.delivery !== "immediate" || !artifact.id) return [];
    const data = artifact.data as Record<string, JsonValue> | null;
    if (!data || data.adapter !== "assistant-ui" || typeof data.catalogVersion !== "string" || typeof data.fallbackText !== "string" || !data.tree) return [];
    return [{ protocolVersion: 1, runId, blockId: `${runId}:${artifact.id}`, toolCallId: artifact.id.slice(0, artifact.id.lastIndexOf(":")), adapter: "assistant-ui", catalogVersion: data.catalogVersion, revision: 1, status: "completed", tree: data.tree, fallbackText: data.fallbackText } satisfies UiBlock];
  });
}
