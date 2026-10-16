import { createChatbotClient, type ChatbotApi } from "@agent-studio/chat-ui";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { request, appId } from "./transport";
export { appId };
const api: ChatbotApi = {
  request: async <T>(method: string, path: string, body?: unknown) => {
    const response = await request("/bot" + path, {
      method,
      ...(body
        ? {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }
        : {}),
    });
    return response.json() as Promise<T>;
  },
  async events(path, event, signal) {
    const response = await request(
      "/bot" + path,
      { signal, headers: { Accept: "text/event-stream" } },
      true,
    );
    if (
      !response.headers.get("content-type")?.includes("text/event-stream") ||
      !response.body
    )
      throw Error("服务器未返回事件流");
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new EventSourceParserStream({
          maxBufferSize: 1024 * 1024,
          onError: "terminate",
        }),
      )
      .getReader();
    const abort = () => void reader.cancel().catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        event(next.value.event ?? "message", JSON.parse(next.value.data));
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
  async upload(path, file) {
    const body = new FormData();
    body.append("file", file);
    return (await request("/bot" + path, { method: "POST", body })).json();
  },
  async download(path) {
    return (await request("/bot" + path)).blob();
  },
};
let storage: Storage | undefined;
try {
  storage = localStorage;
} catch {}
const client = createChatbotClient(api, `agent-studio-chat:${appId}`, storage);
export const chat = client;
import.meta.hot?.dispose(() => chat.dispose());
