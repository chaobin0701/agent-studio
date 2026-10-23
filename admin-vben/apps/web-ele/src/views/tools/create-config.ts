export interface BuiltinToolOption {
  key: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function httpToolConfig(description = "") {
  return {
    description,
    type: "rest",
    endpoint: {
      url: "",
      method: "GET",
      headers: {},
      mappingMode: "explicit",
      bindings: [],
      resultPath: "",
    },
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: 30000,
    maxRetries: 3,
    readOnly: true,
    requiresApproval: false,
  };
}

/** Creation only. Existing versions retain their registered implementation and schema. */
export function builtinToolConfig(
  options: BuiltinToolOption[],
  target: string,
) {
  const registered = options.find((option) => option.key === target);
  if (
    !registered ||
    !registered.parameters ||
    registered.parameters.type !== "object"
  )
    throw new Error("请选择已注册且参数契约有效的内置工具");
  return {
    description: registered.description,
    type: "builtin",
    target: registered.key,
    // Options are Vue proxies. JSON cloning also limits this value to the
    // serializable native contract instead of sharing mutable form state.
    parameters: JSON.parse(JSON.stringify(registered.parameters)) as Record<
      string,
      unknown
    >,
    timeoutMs: 30000,
    maxRetries: 0,
    readOnly: false,
    requiresApproval: false,
  };
}

export function toolTestExample(config: { type?: string; target?: string; uiCatalog?: { components?: Record<string, unknown> } }) {
  if (config.type === "ui" && config.uiCatalog?.components?.Card)
    return { _type: "Card", title: "示例摘要" };
  return config.type === "builtin" && config.target === "ask_user"
    ? {
        question: "你的预算是多少？",
        options: [
          { id: "budget_1", label: "2000 元以内" },
          { id: "budget_2", label: "2000–3000 元" },
        ],
        allowCustom: true,
      }
    : {};
}

/** Catalog is imported from a deployed showcase; it uses the existing Tool release workflow. */
export function uiToolConfig() {
  return { description: "使用 present 展示数据摘要、图表或表格。仅在可视化有助于解释时调用。", type: "ui", target: "present", uiCatalog: null,
    parameters: { type: "object", properties: {} }, timeoutMs: 30000, maxRetries: 0, readOnly: true, requiresApproval: false };
}
