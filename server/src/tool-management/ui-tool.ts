import Ajv from "ajv";
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
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
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
  const validate = (tree: unknown): boolean => {
    if (JSON.stringify(tree)?.length > 6000) return false;
    let count = 0;
    const visit = (node: unknown, depth: number): boolean => {
      if (typeof node === "string") return node.length <= 500;
      if (++count > 80 || depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) return false;
      const { _type, _key, children, ...props } = node as Record<string, unknown>;
      if (typeof _type !== "string" || !Object.hasOwn(catalog.components, _type) ||
          (_key !== undefined && !(typeof _key === "string" && _key.length <= 100) && !(typeof _key === "number" && Number.isFinite(_key)))) return false;
      if (!validators.get(_type)!(props)) return false;
      if (children === undefined) return true;
      return catalog.components[_type]!.children && (Array.isArray(children)
        ? children.length <= 40 && children.every(child => visit(child, depth + 1))
        : visit(children, depth + 1));
    };
    return !!tree && typeof tree === "object" && !Array.isArray(tree) && visit(tree, 0) && Boolean(parameters(tree));
  };
  return { catalog, validate };
}

export function makeUiTool(value: unknown): AgentTool {
  const { catalog, validate } = compileUiCatalog(value);
  return {
    name: "present",
    description: "通过已注册组件呈现只读界面。使用目录指定的组件与属性，不包含操作或表单。",
    parameters: catalog.parameters,
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
