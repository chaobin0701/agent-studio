/** Backend revalidates stored project/trace mapping and permissions. The UI also
 * accepts only the configured class of local collector URLs, including HTTP. */
export function safePhoenixLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value),
      host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    const parts = host.split(".").map(Number);
    const local =
      ["localhost", "::1", "phoenix", "host.docker.internal"].includes(host) ||
      (parts.length === 4 &&
        parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
        (parts[0] === 127 ||
          parts[0] === 10 ||
          (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
          (parts[0] === 192 && parts[1] === 168)));
    return ["http:", "https:"].includes(url.protocol) &&
      local &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /\/redirects\/traces\/[a-f0-9]{32}$/iu.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
