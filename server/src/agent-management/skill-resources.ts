import { z } from "zod";

export const SKILL_RESOURCE_LIMITS = Object.freeze({
  files: 16,
  fileBytes: 64 * 1024,
  totalBytes: 192 * 1024,
  configBytes: 384 * 1024,
});

/** Relative virtual paths, never URLs, host paths or archive entries. */
export function validSkillResourcePath(path: string): boolean {
  const parts = path.split("/");
  // Leave room for /skills/<64-character alias>/ within the 240-char Run gateway.
  return (
    path.length <= 160 &&
    parts.length >= 2 &&
    parts.length <= 6 &&
    ["references", "assets", "scripts"].includes(parts[0]) &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/u.test(part) &&
        !part.endsWith(".") &&
        !["__proto__", "constructor", "prototype"].includes(part),
    )
  );
}

export const skillResourceSchema = z
  .object({
    path: z
      .string()
      .refine(
        validSkillResourcePath,
        "资料路径必须位于 references/、assets/ 或 scripts/，不得使用绝对路径、回退路径或特殊字符",
      ),
    content: z
      .string()
      .refine(
        (text) =>
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) &&
          Buffer.from(text, "utf8").toString("utf8") === text,
        "仅支持有效 UTF-8 文本，不支持二进制文件或控制字符",
      )
      .refine(
        (text) => Buffer.byteLength(text) <= SKILL_RESOURCE_LIMITS.fileBytes,
        "单份资料不能超过 64 KiB",
      ),
  })
  .strict();

export const skillResourcesSchema = z
  .array(skillResourceSchema)
  .max(SKILL_RESOURCE_LIMITS.files, "每个 Skill 最多 16 份辅助资料")
  .refine(
    (files) =>
      new Set(files.map((file) => file.path.toLowerCase())).size ===
      files.length,
    "资料路径不能重复（不区分大小写）",
  )
  .refine(
    (files) =>
      files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <=
      SKILL_RESOURCE_LIMITS.totalBytes,
    "辅助资料总量不能超过 192 KiB",
  )
  .refine(
    (files) =>
      !files.some((file) =>
        files.some((other) =>
          other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`),
        ),
      ),
    "文件路径不能同时作为目录",
  );

export type SkillResource = Readonly<z.infer<typeof skillResourceSchema>>;

export const skillBundleSchema = z
  .object({
    format: z.literal("agent-skill-bundle"),
    version: z.literal(1),
    document: z.string().max(75000),
    resources: skillResourcesSchema,
  })
  .strict()
  .refine(
    (bundle) =>
      Buffer.byteLength(JSON.stringify(bundle)) <=
      SKILL_RESOURCE_LIMITS.configBytes,
    "完整 Skill 包不能超过 384 KiB",
  );
