import { normalizeSchema } from "@agent-studio/output-contract";
export type OutputField = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumText: string;
};
const fieldTypes = ["string", "number", "integer", "boolean", "null"];
/** Only offer fields when the entire schema is representable; source is lossless. */
export function schemaFields(value: unknown): OutputField[] | undefined {
  try {
    const s = normalizeSchema(value);
    if (s.additionalProperties !== false) return;
    const rows: OutputField[] = [];
    for (const [name, field] of Object.entries(s.properties) as [
      string,
      any,
    ][]) {
      if (
        !fieldTypes.includes(field.type) ||
        Object.keys(field).some(
          (k) => !["type", "description", "enum"].includes(k),
        )
      )
        return;
      rows.push({
        name,
        type: field.type,
        description: field.description ?? "",
        required: s.required.includes(name),
        enumText: field.enum ? JSON.stringify(field.enum) : "",
      });
    }
    return rows;
  } catch {
    return;
  }
}
export function fieldsSchema(base: unknown, rows: OutputField[]) {
  const names = rows.map((r) => r.name.trim());
  if (names.some((n) => !n) || new Set(names).size !== names.length)
    throw new Error("字段名称不能为空或重复");
  return normalizeSchema({
    ...normalizeSchema(base),
    properties: Object.fromEntries(
      rows.map((r, i) => [
        names[i],
        {
          type: r.type,
          ...(r.description ? { description: r.description } : {}),
          ...(r.enumText.trim() ? { enum: JSON.parse(r.enumText) } : {}),
        },
      ]),
    ),
    required: rows.filter((r) => r.required).map((r) => r.name.trim()),
  });
}
export const OUTPUT_TEMPLATES = [
  {
    key: "extract",
    name: "通用字段提取",
    schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "提取的主题" },
        details: { type: "string", description: "与主题相关的已确认信息" },
      },
      required: ["subject", "details"],
      additionalProperties: false,
    },
  },
  {
    key: "list",
    name: "列表结果",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "任务要求的结果列表",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "条目标题" },
              description: { type: "string", description: "条目说明" },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    key: "actions",
    name: "交互动作",
    schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "建议的下一步动作，仅提供数据，不直接执行",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "动作展示名称" },
              type: { type: "string", description: "调用方约定的动作类型" },
              params: {
                type: "object",
                description: "动作参数，请按调用方协议补充属性",
                properties: {},
                additionalProperties: false,
              },
            },
            required: ["label", "type", "params"],
            additionalProperties: false,
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
];
