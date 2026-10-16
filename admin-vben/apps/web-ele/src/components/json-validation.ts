import { parseJson } from "@agent-studio/output-contract";
export type JsonKind = "any" | "object" | "array";
export type JsonValidation =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Syntax validation is deliberately independent of each API's schema validation. */
export function validateJson(
  text: string,
  kind: JsonKind = "any",
  allowEmpty = false,
): JsonValidation {
  if (allowEmpty && !text.trim()) return { ok: true, value: undefined };
  const parsed = parseJson(text);
  if (parsed.error) return { ok: false, message: parsed.error };
  const value: unknown = parsed.value;
  if (
    kind === "object" &&
    (!value || Array.isArray(value) || typeof value !== "object")
  )
    return {
      ok: false,
      message: "必须填写 JSON 对象，例如 {}，不能使用数组、null 或普通文本。",
    };
  if (kind === "array" && !Array.isArray(value))
    return { ok: false, message: "必须填写 JSON 数组，例如 []。" };
  return { ok: true, value };
}

export function sameJson(text: string, value: unknown) {
  const parsed = validateJson(text);
  return parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(value);
}

export function validateHeaders(value: unknown): string | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object")
    return "请求头必须是 JSON 对象。";
  if (Object.values(value).some((item) => typeof item !== "string"))
    return '请求头的值必须是字符串，例如 {"Accept": "application/json"}。';
  return undefined;
}
