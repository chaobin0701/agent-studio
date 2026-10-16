const Ajv = require("ajv");
const { parseTree } = require("jsonc-parser");
const ajv = new Ajv({
  strict: true,
  allErrors: false,
  ownProperties: true,
  addUsedSchema: false,
});
const cache = new Map();
const compile = (schema) => {
  const fn = ajv.compile(schema);
  ajv.removeSchema(schema);
  return fn;
};
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const common = ["type", "title", "description", "enum"];
const allowed = {
  object: [...common, "properties", "required", "additionalProperties"],
  array: [...common, "items", "minItems", "maxItems"],
  string: [...common, "minLength", "maxLength"],
  number: [
    ...common,
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ],
  integer: [
    ...common,
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ],
  boolean: common,
  null: common,
};
class OutputContractError extends Error {
  constructor(code, issues) {
    const bounded = issues.slice(0, 12).map((i) => ({
      path: String(i.path).slice(0, 240),
      message: String(i.message).slice(0, 240),
    }));
    super(bounded.map((i) => `${i.path}: ${i.message}`).join("；"));
    this.name = "OutputContractError";
    this.code = code;
    this.issues = bounded;
  }
}
const fail = (path, message) => {
  throw new OutputContractError("output_schema_invalid", [
    { path: path || "$", message },
  ]);
};
const object = (v) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
function normalizeSchema(value) {
  // Bound the complete JSON before invoking any compiler (also reject cycles/non-JSON).
  let nodes = 0;
  const seen = new WeakSet();
  const visit = (v, d, p) => {
    if (++nodes > 1000 || d > 10)
      fail(p, "规范超过深度或节点上限（10 层 / 1000 节点）");
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return;
    if (typeof v !== "object" || seen.has(v))
      fail(p, "必须为无循环的 JSON 数据");
    seen.add(v);
    if (!Array.isArray(v) && !object(v)) fail(p, "必须为 JSON 对象");
    for (const [k, c] of Object.entries(v)) {
      if (forbidden.has(k)) fail(`${p}.${k}`, "不支持该字段名");
      visit(c, d + 1, `${p}.${k}`);
    }
    seen.delete(v);
  };
  visit(value, 0, "$");
  if (JSON.stringify(value).length > 12000)
    fail("$", "规范不能超过 12000 字符");
  const walk = (s, p, root = false) => {
    if (!object(s)) fail(p, "必须是 Schema 对象");
    let types = Array.isArray(s.type) ? s.type : [s.type];
    if (
      types.length < 1 ||
      types.length > 2 ||
      new Set(types).size !== types.length ||
      types.some((t) => !Object.hasOwn(allowed, t)) ||
      (types.length === 2 && !types.includes("null"))
    )
      fail(`${p}.type`, "必须声明单一类型，可附加 null");
    const base = types.find((t) => t !== "null") || "null";
    if (root && (types.length !== 1 || base !== "object"))
      fail(`${p}.type`, "根节点必须是 object");
    for (const k of Object.keys(s))
      if (!(root && k === "$schema") && !allowed[base].includes(k))
        fail(`${p}.${k}`, "当前运行时不支持此关键字");
    if (s.$schema && s.$schema !== "http://json-schema.org/draft-07/schema#")
      fail(`${p}.$schema`, "仅支持 JSON Schema draft-07 子集，可移除此声明");
    for (const k of ["title", "description"])
      if (s[k] !== undefined && typeof s[k] !== "string")
        fail(`${p}.${k}`, "必须为字符串");
    const out = { ...s, type: types.length === 1 ? base : [base, "null"] };
    delete out.$schema;
    if (base === "object") {
      if (s.properties !== undefined && !object(s.properties))
        fail(`${p}.properties`, "必须为对象");
      out.properties = Object.fromEntries(
        Object.entries(s.properties || {}).map(([k, v]) => [
          k,
          walk(v, `${p}.properties.${k}`),
        ]),
      );
      if (
        s.additionalProperties !== undefined &&
        typeof s.additionalProperties !== "boolean"
      )
        fail(`${p}.additionalProperties`, "仅支持布尔值");
      out.additionalProperties = s.additionalProperties ?? false;
      const req = s.required ?? [];
      if (
        !Array.isArray(req) ||
        req.some(
          (k) => typeof k !== "string" || !Object.hasOwn(out.properties, k),
        ) ||
        new Set(req).size !== req.length
      )
        fail(`${p}.required`, "必填字段必须存在且不能重复");
      out.required = [...req].sort();
    }
    if (base === "array") {
      if (!s.items) fail(`${p}.items`, "数组必须定义元素 Schema");
      out.items = walk(s.items, `${p}.items`);
    }
    for (const [min, max] of [
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
      ["minimum", "maximum"],
      ["exclusiveMinimum", "exclusiveMaximum"],
    ]) {
      for (const k of [min, max])
        if (
          s[k] !== undefined &&
          (typeof s[k] !== "number" ||
            !Number.isFinite(s[k]) ||
            (["minLength", "maxLength", "minItems", "maxItems"].includes(k) &&
              (!Number.isInteger(s[k]) || s[k] < 0)))
        )
          fail(`${p}.${k}`, "必须是有效的非负整数或数值边界");
      if (
        s[min] !== undefined &&
        s[max] !== undefined &&
        (s[min] > s[max] || (min === "exclusiveMinimum" && s[min] === s[max]))
      )
        fail(p, "最小约束不能大于最大约束，排他边界不能相等");
    }
    const lower = Math.max(
        s.minimum ?? -Infinity,
        s.exclusiveMinimum ?? -Infinity,
      ),
      upper = Math.min(s.maximum ?? Infinity, s.exclusiveMaximum ?? Infinity);
    if (
      lower > upper ||
      (lower === upper &&
        (s.exclusiveMinimum === lower || s.exclusiveMaximum === upper))
    )
      fail(p, "数值边界没有可用值");
    if (
      base === "integer" &&
      Number.isFinite(lower) &&
      Number.isFinite(upper)
    ) {
      const lo =
          Math.ceil(lower) +
          (Number.isInteger(lower) && s.exclusiveMinimum === lower ? 1 : 0),
        hi =
          Math.floor(upper) -
          (Number.isInteger(upper) && s.exclusiveMaximum === upper ? 1 : 0);
      if (lo > hi) fail(p, "数值边界中没有整数");
    }
    if (s.enum !== undefined) {
      if (
        !Array.isArray(s.enum) ||
        !s.enum.length ||
        s.enum.length > 100 ||
        s.enum.some(
          (v) =>
            v !== null && !["string", "boolean", "number"].includes(typeof v),
        ) ||
        new Set(s.enum.map((v) => JSON.stringify(v))).size !== s.enum.length
      )
        fail(`${p}.enum`, "枚举须包含 1–100 个不重复的基础值");
      const without = { ...out };
      delete without.enum;
      let check;
      try {
        check = compile(without);
      } catch {
        fail(p, "字段约束无效");
      }
      if (s.enum.some((v) => !check(v)))
        fail(`${p}.enum`, "枚举值必须符合字段类型和约束");
      out.enum = [...s.enum].sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b)
          ? -1
          : JSON.stringify(a) > JSON.stringify(b)
            ? 1
            : 0,
      );
    }
    return out;
  };
  const normalized = canonical(walk(value, "$", true));
  try {
    validator(normalized);
  } catch (e) {
    if (e instanceof OutputContractError) throw e;
    fail("$", "Schema 未通过运行时编译，请检查类型和约束");
  }
  return normalized;
}
function validator(schema) {
  const key = JSON.stringify(schema);
  if (cache.has(key)) return cache.get(key);
  const compiled = compile(schema);
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, compiled);
  return compiled;
}
function validateStructured(schema, value) {
  const normalized = normalizeSchema(schema),
    check = validator(normalized);
  if (check(value)) return [];
  return (check.errors || []).slice(0, 12).map((e) => ({
    path: (
      "$" +
      e.instancePath.replace(/\//g, ".") +
      (e.keyword === "required"
        ? "." + e.params.missingProperty
        : e.keyword === "additionalProperties"
          ? "." + e.params.additionalProperty
          : "")
    ).slice(0, 240),
    message:
      {
        required: "缺少必填字段",
        additionalProperties: "不允许额外字段",
        type: "字段类型不匹配",
        enum: "值不在枚举中",
        minLength: "字符串过短",
        maxLength: "字符串过长",
        minItems: "数组元素不足",
        maxItems: "数组元素过多",
        minimum: "小于最小值",
        maximum: "超过最大值",
        exclusiveMinimum: "未超过下界",
        exclusiveMaximum: "未低于上界",
      }[e.keyword] || "不符合字段约束",
  }));
}
function normalizeContract(v) {
  if (!object(v) || !["text", "json"].includes(v.mode))
    fail("output", "请选择文本或结构化 JSON");
  if (
    Object.keys(v).some(
      (k) => !["mode", ...(v.mode === "json" ? ["schema"] : [])].includes(k),
    )
  )
    fail("output", "包含不支持的配置字段");
  return v.mode === "text"
    ? { mode: "text" }
    : { mode: "json", schema: normalizeSchema(v.schema) };
}
function resolveContract(configured, requested) {
  if (configured === undefined)
    return requested === undefined
      ? { mode: "text", source: "legacy" }
      : { mode: "json", source: "request", schema: normalizeSchema(requested) };
  const c = normalizeContract(configured);
  if (
    requested !== undefined &&
    (c.mode !== "json" ||
      JSON.stringify(c.schema) !== JSON.stringify(normalizeSchema(requested)))
  )
    throw new OutputContractError("output_contract_conflict", [
      { path: "outputSchema", message: "请求不能覆盖 Agent 已配置的输出规范" },
    ]);
  return { ...c, source: "agent" };
}
function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    const errors = [];
    try {
      parseTree(text, errors, {
        allowTrailingComma: false,
        disallowComments: true,
        allowEmptyContent: false,
      });
    } catch {}
    const offset = errors[0]?.offset ?? text.length,
      prefix = text.slice(0, offset),
      line = prefix.split("\n").length,
      column = offset - (prefix.lastIndexOf("\n") + 1) + 1;
    return {
      error: `JSON 语法错误：第 ${line} 行，第 ${column} 列`,
      line,
      column,
    };
  }
}
function schemaExample(schema) {
  const normalized = normalizeSchema(schema);
  const make = (s) => {
    if (s.enum) return s.enum[0];
    const type = Array.isArray(s.type) ? s.type[0] : s.type;
    if (type === "object")
      return Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, make(v)]),
      );
    if (type === "array")
      return Array.from(
        { length: Math.min(5, s.maxItems ?? 5, Math.max(1, s.minItems ?? 0)) },
        () => make(s.items),
      );
    if (type === "string")
      return "示".repeat(
        Math.min(1000, Math.max(0, s.minLength ?? (s.maxLength === 0 ? 0 : 2))),
      );
    if (type === "boolean") return false;
    if (type === "null") return null;
    let n =
      s.minimum ??
      (s.exclusiveMinimum !== undefined
        ? s.exclusiveMinimum + 1
        : Math.min(0, s.maximum ?? 0));
    if (type === "integer") n = Math.ceil(n);
    if (s.maximum !== undefined) n = Math.min(n, s.maximum);
    if (s.exclusiveMaximum !== undefined && n >= s.exclusiveMaximum)
      n = s.exclusiveMaximum - 1;
    return n;
  };
  const value = make(normalized);
  return validateStructured(normalized, value).length ? undefined : value;
}
module.exports = {
  OutputContractError,
  normalizeSchema,
  normalizeContract,
  resolveContract,
  validateStructured,
  parseJson,
  schemaExample,
};
