import type { ChatbotApi } from "@agent-studio/chat-ui";
import { requestClient } from "./request";
import { consumeEventStream } from "./event-stream";

export const chatbotApi: ChatbotApi = {
  request: async <T>(method: string, path: string, body?: unknown) => {
    const url = "/chatbot" + path;
    if (method === "POST") return requestClient.post<T>(url, body);
    if (method === "PATCH")
      return requestClient.request<T>(url, { method: "PATCH", data: body });
    if (method === "DELETE") return requestClient.delete<T>(url);
    return requestClient.get<T>(url);
  },
  async events(path, event, signal) {
    const stream = await requestClient.get<ReadableStream<Uint8Array>>(
      "/chatbot" + path,
      {
        adapter: "fetch",
        responseType: "stream",
        signal,
        headers: { Accept: "text/event-stream" },
      },
    );
    await consumeEventStream(
      stream,
      (value) => {
        if (value.data) event(value.event ?? "message", JSON.parse(value.data));
      },
      signal,
    );
  },
  upload(path, file) {
    const body = new FormData();
    body.append("file", file);
    return requestClient.post("/chatbot" + path, body, {
      headers: { "Content-Type": undefined },
    });
  },
  download: (path) =>
    requestClient.get<Blob>("/chatbot" + path, { responseType: "blob" }),
};
