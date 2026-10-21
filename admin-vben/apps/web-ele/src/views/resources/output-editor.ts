import { normalizeSchema, type JsonSchema } from "@agent-studio/output-contract";

export const EMPTY_OUTPUT_SCHEMA = { type: "object", properties: {}, required: [], additionalProperties: false };
export const FIELD_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
export type OutputField = {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  description: string;
  required: boolean;
  enumText: string;
  schema: JsonSchema;
  children: OutputField[];
  isItem?: boolean;
};
let nextId = 0;
function field(name: string, schema: JsonSchema, required = false, isItem = false): OutputField {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((t: string) => t !== "null") ?? "null";
  return {
    id: "output-field-" + ++nextId, name, type, required, isItem,
    nullable: type !== "null" && types.includes("null"),
    description: schema.description ?? "",
    enumText: schema.enum ? JSON.stringify(schema.enum) : "",
    schema: structuredClone(schema),
    children: type === "object"
      ? Object.entries(schema.properties ?? {}).map(([key, value]) => field(key, value as JsonSchema, schema.required?.includes(key)))
      : type === "array" ? [field("数组元素", schema.items, false, true)] : [],
  };
}
/** Keep every supported source keyword on its owning node, including source-only annotations. */
export function schemaFields(value: unknown): OutputField[] | undefined {
  try {
    const schema = normalizeSchema(value);
    return Object.entries(schema.properties).map(([name, value]) =>
      field(name, value as JsonSchema, schema.required.includes(name)));
  } catch { return undefined; }
}
function objectFields(rows: OutputField[]) {
  const names = rows.map(row => row.name.trim());
  if (names.some(name => !name) || new Set(names).size !== names.length)
    throw new Error("同一对象内的字段名称不能为空或重复");
  return {
    properties: Object.fromEntries(rows.map((row, i) => [names[i]!, fieldSchema(row)])),
    required: rows.filter(row => row.required).map(row => row.name.trim()),
  };
}
function fieldSchema(row: OutputField): JsonSchema {
  const schema: JsonSchema = { ...row.schema, type: row.nullable && row.type !== "null" ? [row.type, "null"] : row.type };
  if (row.description) schema.description = row.description;
  else delete schema.description;
  if (row.enumText.trim()) {
    try { schema.enum = JSON.parse(row.enumText); }
    catch { throw new Error(row.name + "：枚举必须是 JSON 数组"); }
  } else delete schema.enum;
  // InputNumber clears a limit to undefined/null; omission removes only that explicit limit.
  for (const key of ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems"])
    if (schema[key] === undefined || schema[key] === null) delete schema[key];
  if (row.type === "object") Object.assign(schema, objectFields(row.children));
  if (row.type === "array") {
    if (row.children.length !== 1) throw new Error("数组必须有一个元素类型");
    schema.items = fieldSchema(row.children[0]!);
  }
  return schema;
}
export function fieldsSchema(base: unknown, rows: OutputField[]) {
  return normalizeSchema({ ...normalizeSchema(base), ...objectFields(rows) });
}
export function addField(rows: OutputField[]) {
  let index = 1;
  while (rows.some(row => row.name === "field_" + index)) index++;
  const created = field("field_" + index, { type: "string" });
  rows.push(created);
  return created;
}
export function addSuggestedFollowUpsField(rows: OutputField[]) {
  const row = addField(rows);
  row.name = "suggestedFollowUps";
  row.type = "array";
  row.description = "可选的后续追问，最多 3 条";
  changeFieldType(row);
  row.schema.maxItems = 3;
  const item = row.children[0]!;
  item.type = "string";
  item.description = "一条简短、具体的追问";
  item.schema.maxLength = 120;
  return row;
}
export function changeFieldType(row: OutputField) {
  // Changing a type is explicit; merely switching views never runs this reset.
  row.schema = { type: row.type, ...(row.schema.title ? { title: row.schema.title } : {}) };
  row.enumText = "";
  row.children = row.type === "array" ? [field("数组元素", { type: "string" }, false, true)] : [];
  if (row.type === "null") row.nullable = false;
}
export function copyField(rows: OutputField[], target: OutputField) {
  let name = target.name + "_copy", index = 2;
  while (rows.some(row => row.name === name)) name = target.name + "_copy_" + index++;
  // Clone the edit buffer too: an incomplete enum or name must not silently disappear.
  const copy = structuredClone(JSON.parse(JSON.stringify(target))) as OutputField;
  const identify = (item: OutputField) => { item.id = "output-field-" + ++nextId; item.children.forEach(identify); };
  identify(copy);
  copy.name = name;
  rows.splice(rows.indexOf(target) + 1, 0, copy);
  return copy;
}
export function fieldSiblings(rows: OutputField[], id: string): OutputField[] | undefined {
  if (rows.some(row => row.id === id)) return rows;
  for (const row of rows) {
    const found = fieldSiblings(row.children, id);
    if (found) return found;
  }
}
