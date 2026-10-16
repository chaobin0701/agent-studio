import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ToolSpec,
  ResourceVersion,
} from "../agent-management/resource.types";
import type { AgentTool } from "../ai/tools/agent-tool";
import type { ToolContext } from "../ai/tools/tool-context";
import type { ToolCredential } from "./tool-config";
import { redactToolData } from "./network";

export type HttpDependencies = {
  fetch?: typeof fetch;
  credential?: (id: number) => Promise<ToolCredential>;
};
export function httpRequest(
  spec: ToolSpec,
  input: Record<string, unknown>,
  credential?: ToolCredential,
) {
  const endpoint = spec.endpoint!;
  let address = endpoint.url;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...endpoint.headers,
  };
  const body: Record<string, unknown> = {};
  const queries: [string, string][] = [];
  const render = (v: unknown) =>
    typeof v === "object" ? JSON.stringify(v) : String(v);
  if (endpoint.mappingMode === "explicit")
    for (const binding of endpoint.bindings) {
      if (
        !Object.hasOwn(input, binding.source) ||
        input[binding.source] === undefined
      )
        continue;
      const value = input[binding.source];
      if (binding.location === "path")
        address = address.replaceAll(
          `{${binding.target}}`,
          encodeURIComponent(render(value)),
        );
      if (binding.location === "query")
        queries.push([binding.target, render(value)]);
      if (binding.location === "header") {
        const text = render(value);
        if (/[\r\n]/.test(text)) throw new Error("invalid_tool_header");
        headers[binding.target] = text;
      }
      if (binding.location === "body") {
        const parts = binding.target.split(".");
        let object = body;
        for (const part of parts.slice(0, -1)) {
          if (["__proto__", "prototype", "constructor"].includes(part))
            throw new Error("invalid_tool_mapping");
          const existing = object[part];
          if (
            existing !== undefined &&
            (typeof existing !== "object" ||
              existing === null ||
              Array.isArray(existing))
          )
            throw new Error("invalid_tool_mapping");
          object = (object[part] ??= {}) as Record<string, unknown>;
        }
        const last = parts.at(-1)!;
        if (["__proto__", "prototype", "constructor"].includes(last))
          throw new Error("invalid_tool_mapping");
        object[last] = value;
      }
    }
  if (/\{[^}]+\}/.test(address)) throw new Error("missing_tool_path_parameter");
  const url = new URL(address);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("invalid_tool_endpoint");
  if (endpoint.mappingMode !== "explicit") {
    if (endpoint.method === "GET")
      for (const [key, value] of Object.entries(input))
        queries.push([key, render(value)]);
    else Object.assign(body, input);
  }
  for (const [key, value] of queries) url.searchParams.append(key, value);
  if (credential)
    headers[
      credential.kind === "bearer" ? "Authorization" : credential.header
    ] =
      credential.kind === "bearer"
        ? `Bearer ${credential.secret}`
        : credential.secret;
  const hasBody = endpoint.method !== "GET";
  if (hasBody) headers["Content-Type"] = "application/json";
  return { url, headers, ...(hasBody ? { body: JSON.stringify(body) } : {}) };
}

export async function executeHttp(
  v: ResourceVersion,
  input: Record<string, unknown>,
  context: ToolContext,
  deps: HttpDependencies = {},
) {
  const spec = v.config as ToolSpec;
  let credential: ToolCredential | undefined;
  if (spec.endpoint?.credentialId) {
    if (!deps.credential) throw new Error("tool_credential_missing");
    credential = await deps.credential(spec.endpoint.credentialId);
  }
  const request = httpRequest(spec, input, credential);
  if (spec.endpoint!.credentialEnv) {
    const { currentWorkspaceId } = await import(
      "../workspaces/workspace-context"
    );
    const reference = spec.endpoint!.credentialEnv;
    if (
      !reference.startsWith("AGENT_TOOL_") ||
      (currentWorkspaceId() !== 1 &&
        !reference.startsWith(`AGENT_TOOL_WS_${currentWorkspaceId()}_`))
    )
      throw new Error("tool_credential_forbidden");
    const secret = process.env[reference];
    if (!secret)
      return {
        success: false,
        content: "工具凭据未配置",
        errorCode: "tool_credential_missing",
      };
    request.headers.Authorization = `Bearer ${secret}`;
    credential = { kind: "bearer", header: "Authorization", secret };
  }
  if (spec.idempotencyHeader)
    request.headers[spec.idempotencyHeader] = createHash("sha256")
      .update(JSON.stringify([context.traceId, v.id, input]))
      .digest("hex");
  const started = Date.now();
  const response = await (deps.fetch ?? fetch)(request.url, {
    method: spec.endpoint!.method,
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(spec.timeoutMs)])
      : AbortSignal.timeout(spec.timeoutMs),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1024 * 1024) throw new Error("tool_response_too_large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
  const raw = Buffer.concat(chunks).toString("utf8");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  data = redactToolData(data, credential ? [credential.secret] : []);
  const metadata = {
    status: response.status,
    durationMs: Date.now() - started,
  };
  if (!response.ok)
    return {
      success: false,
      content: `HTTP ${response.status}：${(typeof data === "string" ? data : JSON.stringify(data)).slice(0, 1000)}`,
      errorCode:
        response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "service_unavailable"
            : "tool_http_error",
      metadata,
    };
  if (spec.endpoint!.resultPath)
    for (const key of spec.endpoint!.resultPath.split(".")) {
      if (
        data === null ||
        typeof data !== "object" ||
        !Object.hasOwn(data, key)
      )
        return {
          success: false,
          content: "结果提取路径不存在",
          errorCode: "tool_result_path_missing",
          metadata,
        };
      data = data[key];
    }
  if (
    spec.outputSchema &&
    !z.fromJSONSchema(spec.outputSchema as any).safeParse(data).success
  )
    return {
      success: false,
      content: "返回内容不符合输出 Schema",
      errorCode: "tool_output_invalid",
      metadata,
    };
  return {
    success: true,
    content: typeof data === "string" ? data : JSON.stringify(data),
    data,
    metadata,
  };
}
