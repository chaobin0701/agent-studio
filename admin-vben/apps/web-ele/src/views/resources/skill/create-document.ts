import { parseDocument, stringify } from "yaml";
import { frontmatterSection } from "./frontmatter";

/** Existing runtime Keys use underscores; the portable name uses hyphens. */
export function skillCreateKey(input: string) {
  const value = input.trim();
  if (!/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(value) || value.length > 64)
    throw new Error(
      "Key 最多 64 字符，使用小写字母、数字、下划线或短横线，不以分隔符结尾",
    );
  return { key: value.replaceAll("-", "_"), name: value.replaceAll("_", "-") };
}

/** Form-driven creation, with empty body unless importing an existing document. */
export function createSkillDocument(
  key: string,
  description: string,
  imported?: string,
) {
  const identity = skillCreateKey(key),
    text = description.trim();
  if (!text || text.length > 1024)
    throw new Error("描述不能为空，最多 1024 字符");
  let yaml: string,
    body = "";
  if (imported !== undefined) {
    const section = frontmatterSection(imported, "skill");
    if (!section) throw new Error("导入文件缺少 YAML 起止分隔符");
    const document = parseDocument(section.yaml, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      throw new Error("导入文件的 YAML 格式不正确");
    document.set("name", identity.name);
    document.set("description", text);
    // This local mapping follows the explicitly entered Key, not the source workspace.
    if (document.hasIn(["metadata", "agent-studio-key"]))
      document.setIn(["metadata", "agent-studio-key"], identity.key);
    yaml = document.toString();
    body = section.body ?? "";
  } else {
    yaml = stringify({ name: identity.name, description: text });
  }
  return { key: identity.key, document: `---\n${yaml}---\n${body}` };
}
