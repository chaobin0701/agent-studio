import { BadRequestException } from "@nestjs/common";
import type { PromptVariableMap } from "./prompt.types";

const tokens = () => /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]{0,79})\s*\}\}/g;
export function extractVariables(template: string) {
  return [
    ...new Set([...template.matchAll(tokens())].map((match) => match[1]!)),
  ];
}
export function validatePromptTemplate(
  template: string,
  variables: PromptVariableMap,
) {
  if (!template.trim()) throw new BadRequestException("提示词正文不能为空");
  const names = extractVariables(template);
  for (const name of names)
    if (!Object.hasOwn(variables, name))
      throw new BadRequestException(`未声明模板变量：${name}`);
  const unused = Object.keys(variables).filter((name) => !names.includes(name));
  if (unused.length)
    throw new BadRequestException(`变量声明未用于正文：${unused.join("、")}`);
}
export function renderPrompt(
  template: string,
  variables: PromptVariableMap,
  input: Record<string, unknown>,
) {
  const issues: { name: string; message: string }[] = [];
  for (const name of extractVariables(template)) {
    const definition = Object.hasOwn(variables, name)
      ? variables[name]
      : undefined;
    if (!definition) {
      issues.push({ name, message: `未声明模板变量：${name}` });
      continue;
    }
    const value = input[name];
    if (value === undefined || value === null) {
      if (definition.required)
        issues.push({ name, message: `缺少必填变量：${name}` });
    } else if (!matches(definition.type, value))
      issues.push({
        name,
        message: `变量 ${name} 的类型不正确，应为 ${definition.type}`,
      });
  }
  for (const [name, definition] of Object.entries(variables))
    if (
      definition.required &&
      (input[name] === undefined || input[name] === null) &&
      !issues.some((issue) => issue.name === name)
    )
      issues.push({ name, message: `缺少必填变量：${name}` });
  if (issues.length)
    throw new BadRequestException({
      message: issues.map((issue) => issue.message).join("；"),
      fields: issues,
    });
  return template.replace(tokens(), (_, name: string) => format(input[name]));
}
function matches(type: string, value: unknown) {
  return type === "string"
    ? typeof value === "string"
    : type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : type === "boolean"
        ? typeof value === "boolean"
        : type === "array"
          ? Array.isArray(value)
          : typeof value === "object" &&
            value !== null &&
            !Array.isArray(value);
}
function format(value: unknown) {
  return value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
