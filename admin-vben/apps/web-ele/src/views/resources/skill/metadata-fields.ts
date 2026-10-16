import { isMap, parseDocument } from "yaml";

function metadataDocument(source: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (
    document.errors.length ||
    document.warnings.length ||
    !isMap(document.contents)
  )
    throw new Error("请先修复 Frontmatter 格式，再使用表单编辑");
  // Match the existing source editor: aliases cannot expand into hidden metadata.
  document.toJS({ maxAliasCount: 0 });
  return document;
}

export function readSkillMetadata(source: string) {
  try {
    const document = metadataDocument(source);
    const name = document.get("name"),
      description = document.get("description");
    return {
      name: typeof name === "string" ? name : "",
      description: typeof description === "string" ? description : "",
    };
  } catch {
    return undefined;
  }
}

/** Edit only a daily-use field, retaining comments, optional/unknown metadata and order. */
export function updateSkillMetadata(
  source: string,
  field: "name" | "description",
  value: string,
) {
  const document = metadataDocument(source);
  document.set(field, value);
  return document.toString().trimEnd();
}
