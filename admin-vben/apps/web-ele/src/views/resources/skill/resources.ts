export type SkillResource = { path: string; content: string };
export const skillResourceLimits = {
  files: 16,
  fileBytes: 65536,
  totalBytes: 196608,
  bundleBytes: 393216,
} as const;
export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).byteLength;

/** Client preflight only. The backend is the authoritative schema/budget gate. */
export function resourceError(
  files: readonly SkillResource[],
): string | undefined {
  if (files.length > skillResourceLimits.files)
    return "每个 Skill 最多 16 份辅助资料";
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    if (
      file.path.length > 160 ||
      parts.length < 2 ||
      parts.length > 6 ||
      !["references", "assets", "scripts"].includes(parts[0]!) ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/u.test(part) ||
          part.endsWith(".") ||
          ["__proto__", "constructor", "prototype"].includes(part),
      )
    )
      return "路径必须位于 references/、assets/ 或 scripts/，只能使用字母、数字、下划线、连字符和文件扩展名";
    const key = file.path.toLowerCase();
    if (paths.has(key)) return "资料路径不能重复（不区分大小写）";
    paths.add(key);
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(file.content) ||
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        new TextEncoder().encode(file.content),
      ) !== file.content
    )
      return "仅支持有效 UTF-8 文本，不支持二进制文件或控制字符";
    const size = utf8Bytes(file.content);
    if (size > skillResourceLimits.fileBytes) return "单份资料不能超过 64 KiB";
    bytes += size;
  }
  if (
    [...paths].some((path) =>
      [...paths].some((other) => other.startsWith(`${path}/`)),
    )
  )
    return "文件路径不能同时作为目录";
  if (bytes > skillResourceLimits.totalBytes)
    return "辅助资料总量不能超过 192 KiB";
  return undefined;
}

export async function readResourceFile(
  file: Pick<File, "size" | "arrayBuffer">,
): Promise<string> {
  if (file.size > skillResourceLimits.fileBytes)
    throw new Error("单份资料不能超过 64 KiB");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error("文件必须是 UTF-8 文本，不能上传二进制文件");
  }
}

export function comparableResources(
  files: readonly SkillResource[] = [],
): string {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `\n--- ${file.path} ---\n${file.content}`)
    .join("\n");
}
