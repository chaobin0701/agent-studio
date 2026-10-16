type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Short-lived, origin-bound visitor credentials only. Never accepts a platform API key. */
export function createVisitorTransport(
  appId: string,
  fetcher: typeof fetch,
  storage?: StorageLike,
) {
  const key = `agent-studio-visitor:${appId}`;
  let accessToken = "",
    expiresAt = 0,
    session: Promise<void> | undefined;
  const read = () => {
    try {
      return storage?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const save = (v: string) => {
    try {
      storage?.setItem(key, v);
    } catch {}
  };
  async function error(response: Response) {
    const data = await response.json().catch(() => ({}));
    const detail = data.error ?? data;
    return Object.assign(
      Error(
        typeof detail.message === "string"
          ? detail.message
          : `请求失败（${response.status}）`,
      ),
      { status: response.status },
    );
  }
  async function authorize() {
    if (accessToken && Date.now() < expiresAt) return;
    if (session) return session;
    session = (async () => {
      if (!appId) throw Error("请指定有效的接入应用 ID");
      const response = await fetcher("/api/widget/session", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, resumeToken: read() }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw await error(response);
      const value = await response.json();
      accessToken = value.accessToken;
      expiresAt = Date.now() + Math.max(0, value.expiresIn - 30) * 1000;
      save(value.resumeToken);
    })();
    try {
      await session;
    } finally {
      session = undefined;
    }
  }
  return async function request(
    path: string,
    options: RequestInit = {},
    streaming = false,
  ) {
    await authorize();
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    const timeout = AbortSignal.timeout(streaming ? 185000 : 30000);
    const response = await fetcher("/api/chat" + path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
    // Never auto-resubmit a message or an upload after an uncertain response.
    if (response.status === 401) {
      accessToken = "";
      expiresAt = 0;
    }
    if (!response.ok) throw await error(response);
    return response;
  };
}
