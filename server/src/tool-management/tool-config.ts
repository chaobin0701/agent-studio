import { z } from "zod";

export const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/);
export const safeHeaders = z
  .record(
    headerName,
    z
      .string()
      .max(2000)
      .refine((v) => !/[\r\n]/.test(v)),
  )
  .refine(
    (headers) =>
      Object.keys(headers).every(
        (key) =>
          !/^(authorization|cookie|host|content-length|connection|proxy-.*|transfer-encoding)$/i.test(
            key,
          ),
      ),
    "认证请使用凭证引用，不能设置受保护请求头",
  );
export const httpEndpointSchema = z
  .object({
    connection: z.literal("external").default("external"),
    url: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => {
        try {
          new URL(
            value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "sample"),
          );
          return true;
        } catch {
          return false;
        }
      }, "URL 不合法"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    credentialId: z.number().int().positive().optional(),
    resultPath: z.string().max(200).default(""),
    headers: safeHeaders
      .refine(
        (headers) =>
          Object.keys(headers).every(
            (key) => !/token|secret|api[-_]?key|password/i.test(key),
          ),
        "敏感请求头必须使用凭证引用",
      )
      .default({}),
    mappingMode: z.enum(["legacy", "explicit"]).default("legacy"),
    bindings: z
      .array(
        z
          .object({
            source: z.string().min(1).max(100),
            location: z.enum(["path", "query", "header", "body"]),
            target: z
              .string()
              .min(1)
              .max(100)
              .refine(
                (v) =>
                  !v
                    .split(".")
                    .some((p) =>
                      ["__proto__", "prototype", "constructor"].includes(p),
                    ),
              ),
          })
          .strict(),
      )
      .max(80)
      .default([]),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.connection === "external")
      try {
        new URL(v.url);
      } catch {
        c.addIssue({
          code: "custom",
          message: "外部接口必须使用完整 HTTP URL",
        });
      }
    try {
      const url = new URL(v.url);
      if (
        /[{}]/.test(url.origin) ||
        /[{}]/.test(decodeURIComponent(url.search))
      )
        c.addIssue({
          code: "custom",
          message: "URL 占位符只能用于路径，不能改变主机或查询认证信息",
        });
    } catch {}
    if (v.credentialEnv && v.credentialId)
      c.addIssue({ code: "custom", message: "不能同时使用环境变量和管理凭证" });
    if (v.mappingMode === "explicit") {
      const targets = new Set<string>();
      for (const binding of v.bindings) {
        const key = `${binding.location}:${binding.location === "header" ? binding.target.toLowerCase() : binding.target}`;
        if (targets.has(key))
          c.addIssue({ code: "custom", message: "请求映射目标不能重复" });
        targets.add(key);
        if (
          binding.location === "header" &&
          (!safeHeaders.safeParse({ [binding.target]: "value" }).success ||
            /token|secret|api[-_]?key|password/i.test(binding.target))
        )
          c.addIssue({
            code: "custom",
            message: "请求头映射包含非法或受保护字段，请使用凭证引用",
          });
        if (
          binding.location === "path" &&
          !/^[A-Za-z][A-Za-z0-9_]*$/.test(binding.target)
        )
          c.addIssue({ code: "custom", message: "路径参数名称不合法" });
        if (binding.location === "body" && v.method === "GET")
          c.addIssue({ code: "custom", message: "GET 请求不支持请求体映射" });
      }
    }
  });

export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["bearer", "api_key"]),
    header: headerName.default("X-API-Key"),
    secret: z
      .string()
      .min(1)
      .max(8000)
      .refine((v) => !/[\r\n]/.test(v)),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.kind === "api_key" &&
      !safeHeaders.safeParse({ [v.header]: "value" }).success
    )
      c.addIssue({ code: "custom", message: "API Key 请求头名称不合法" });
  });
export const mcpConnectionSchema = z
  .object({
    url: z.url().max(2000),
    credentialId: z.number().int().positive().nullable().default(null),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  })
  .strict();
export type McpConnectionConfig = z.infer<typeof mcpConnectionSchema>;
export type ToolCredential = {
  kind: "bearer" | "api_key";
  header: string;
  secret: string;
};
