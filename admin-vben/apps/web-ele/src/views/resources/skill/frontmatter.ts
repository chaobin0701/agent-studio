import type { Diagnostic } from "@codemirror/lint";
import { isNode, LineCounter, parseDocument } from "yaml";

export type SkillEditorMode = "yaml" | "skill";
export const skillYamlFields = [
  {
    label: "name",
    detail: "必填：稳定名称，小写字母、数字和短横线，最多 64 字符",
  },
  {
    label: "description",
    detail: "必填：说明做什么、何时使用，最多 1024 字符",
  },
  { label: "metadata", detail: "可选：字符串键值元信息，不授予运行权限" },
  { label: "license", detail: "可选：使用和分发许可，不要求填写" },
  {
    label: "compatibility",
    detail: "可选：环境依赖说明，不安装依赖或授予权限",
  },
  {
    label: "allowed-tools",
    detail: "可选实验性声明；本系统实际权限由 Agent 管理",
  },
];

export function frontmatterSection(source: string, mode: SkillEditorMode) {
  if (mode === "yaml") return { yaml: source, offset: 0, body: undefined };
  const match =
    /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(
      source,
    );
  return match
    ? { yaml: match[2]!, offset: match[1]!.length, body: match[3]! }
    : undefined;
}

/** Same YAML checks for the editor markers and the form's save guard. No execution. */
export function frontmatterDiagnostics(
  source: string,
  mode: SkillEditorMode = "yaml",
): Diagnostic[] {
  const section = frontmatterSection(source, mode);
  const marker = (message: string, from = 0, to = from + 1): Diagnostic => ({
    from: Math.min(Math.max(from, 0), source.length),
    to: Math.min(Math.max(to, from, 0), source.length),
    severity: "error",
    message,
  });
  if (!section)
    return [marker("SKILL.md 需要 YAML 起止分隔符（---）和 Markdown 正文")];
  const { yaml, offset } = section,
    counter = new LineCounter();
  const document = parseDocument(yaml, {
    uniqueKeys: true,
    lineCounter: counter,
  });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length)
    return issues.map((e) => {
      const pos = counter.linePos(e.pos[0]);
      const precedingLines = source.slice(0, offset).split("\n").length - 1;
      return marker(
        `YAML 第 ${pos.line + precedingLines} 行、第 ${pos.col} 列：${e.message.split("\n")[0]}`,
        offset + e.pos[0],
        offset + e.pos[1],
      );
    });
  try {
    const meta = document.toJS({ maxAliasCount: 0 });
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      return [marker("Frontmatter 必须为 YAML 键值对象", offset)];
    const fieldError = (field: string, message: string) => {
      const node = document.get(field, true);
      const range = isNode(node) ? node.range : undefined;
      return marker(
        message,
        offset + (range?.[0] ?? 0),
        offset + (range?.[1] ?? Math.min(yaml.length, 1)),
      );
    };
    const diagnostics: Diagnostic[] = [];
    if (
      typeof meta.name !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) ||
      meta.name.length > 64
    )
      diagnostics.push(
        fieldError(
          "name",
          "name 必填，最多 64 字符，使用小写字母、数字和单个短横线",
        ),
      );
    if (
      typeof meta.description !== "string" ||
      !meta.description.trim() ||
      meta.description.trim().length > 1024
    )
      diagnostics.push(
        fieldError(
          "description",
          "description 必填，最多 1024 字符，说明用途和使用时机",
        ),
      );
    for (const key of [
      ...Object.keys(meta),
      ...Object.keys(meta.metadata ?? {}),
    ])
      if (["__proto__", "constructor", "prototype"].includes(key))
        diagnostics.push(marker("YAML 包含不支持的保留字段", offset));
    if (mode === "skill" && !section.body?.trim())
      diagnostics.push({
        ...marker("正文待补充；验证或发布前必须填写", source.length),
        severity: "warning",
      });
    return diagnostics;
  } catch {
    return [marker("YAML 不支持别名或循环引用", offset, offset + yaml.length)];
  }
}
