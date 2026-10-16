import { EventSourceParserStream } from "eventsource-parser/stream";
import type { EventSourceMessage } from "eventsource-parser";

/** Transport-neutral framing only. The caller uses the existing authenticated
 * RequestClient; no reconnect/retry, credentials or alternate fetch client. */
export async function consumeEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: EventSourceMessage) => void,
  signal?: AbortSignal,
) {
  const decoder = new TextDecoder();
  const reader = stream
    .pipeThrough(
      new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk, { stream: true }));
        },
        flush(controller) {
          controller.enqueue(decoder.decode());
        },
      }),
    )
    .pipeThrough(
      new EventSourceParserStream({
        maxBufferSize: 1024 * 1024,
        onError: "terminate",
      }),
    )
    .getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      onEvent(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Axios' fetch adapter returns a stream for non-2xx responses as well. Decode
 * only the bounded JSON error envelope before shared authentication handling. */
export async function readStreamError(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) return undefined;
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
