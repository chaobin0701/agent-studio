/** Validate the run route returned by the permission-checked backend. */
export function safeLangSmithLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (
      (u.protocol !== "https:" && !(local && u.protocol === "http:")) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
    return /^\/o\/[a-f0-9-]{36}\/projects\/p\/[a-f0-9-]{36}\/r\/[a-f0-9-]{36}$/iu.test(
      u.pathname,
    )
      ? u.href
      : null;
  } catch {
    return null;
  }
}
