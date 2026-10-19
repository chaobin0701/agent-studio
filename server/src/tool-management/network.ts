import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class ToolNetworkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast; excludes loopback, ULA, link-local and IPv4-mapped addresses.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^2001:db8:/i.test(address)
  );
}
export function assertToolUrl(raw: string): URL {
  const url = new URL(raw.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "sample"));
  const allowed = (process.env.AGENT_TOOL_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new ToolNetworkError("tool_url_rejected", "工具地址不合法");
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|secret|password|api[_-]?key|authorization/i.test(key),
    )
  )
    throw new ToolNetworkError(
      "tool_url_rejected",
      "认证信息不能放入 URL，请使用凭证引用",
    );
  if (url.protocol === "http:" && !allowed.includes(host))
    throw new ToolNetworkError(
      "tool_url_rejected",
      "HTTP 或内网服务需要部署端配置 AGENT_TOOL_ALLOWED_HOSTS",
    );
  if (isIP(host) && !publicAddress(host) && !allowed.includes(host))
    throw new ToolNetworkError("tool_url_rejected", "工具地址不允许访问此网络");
  return url;
}

/** Resolve once and pin the checked address to the socket: redirects are never followed. */
async function restrictedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const req = new Request(input, init);
  req.headers.set("accept-encoding", "identity");
  const url = assertToolUrl(req.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = (process.env.AGENT_TOOL_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
  req.signal.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  req.signal.throwIfAborted();
  if (
    !addresses.length ||
    (!allowed.includes(host.toLowerCase()) &&
      addresses.some((a) => !publicAddress(a.address)))
  )
    throw new ToolNetworkError(
      "tool_url_rejected",
      "工具域名解析到了受保护网络",
    );
  const selected = addresses[0];
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  if (body && body.length > 1024 * 1024)
    throw new ToolNetworkError("tool_request_too_large", "工具请求超过 1 MB");
  return new Promise<Response>((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: req.method,
        headers: Object.fromEntries(req.headers),
        signal: req.signal,
        lookup: ((_hostname: any, options: any, callback: any) =>
          options?.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family)) as any,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(
            new ToolNetworkError(
              "tool_redirect_rejected",
              "工具服务重定向被阻止",
            ),
          );
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers }));
        } else {
          // MCP clients may cancel a response as soon as their message is read.
          // Guard an in-flight pull after cancellation rather than letting the
          // Node-to-Web adapter enqueue into an already closed controller.
          const iterator = incoming[Symbol.asyncIterator]();
          let closed = false;
          let size = 0;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const part = await iterator.next();
                if (closed) return;
                if (part.done) {
                  closed = true;
                  controller.close();
                  return;
                }
                size += part.value.length;
                if (size > 4 * 1024 * 1024) {
                  closed = true;
                  incoming.destroy();
                  controller.error(new ToolNetworkError("tool_response_too_large", "工具响应超过 4 MB"));
                  return;
                }
                controller.enqueue(new Uint8Array(part.value));
              } catch (error) {
                if (!closed) {
                  closed = true;
                  controller.error(error);
                }
              }
            },
            cancel() {
              closed = true;
              incoming.destroy();
            },
          });
          resolve(new Response(stream, { status, headers }));
        }
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
export const toolFetch: typeof fetch = (input, init) =>
  restrictedFetch(input, init);
export function redactToolData(value: unknown, secrets: string[] = []): any {
  if (typeof value === "string") {
    if (/^[\s]*[\[{]/.test(value))
      try {
        return JSON.stringify(redactToolData(JSON.parse(value), secrets));
      } catch {}
    let result = value;
    for (const secret of secrets)
      if (secret) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(
        /((?:password|secret|access_token|refresh_token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[REDACTED]",
      );
  }
  if (Array.isArray(value)) return value.map((v) => redactToolData(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /^(authorization|cookie|password|secret|token|access_token|refresh_token|api[_-]?key)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactToolData(v, secrets),
      ]),
    );
  return value;
}
