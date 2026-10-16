import type { Response } from "express";
import { publicIntegrationError } from "../integrations/quota-error";
import type { ChatbotPrincipal } from "./chatbot.types";
import type { ChatbotService } from "./chatbot.service";

/** A disconnected view unsubscribes; only an explicit cancellation stops the task. */
export async function streamChatbot(
  service: ChatbotService,
  principal: ChatbotPrincipal,
  sessionId: string,
  runId: string,
  response: Response,
  replayed = false,
) {
  const initial = await service.turn(principal, sessionId, runId);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  let closed = false,
    polling = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    response.off("close", close);
    if (!response.destroyed && !response.writableEnded) response.end();
  };
  const send = (event: string, data: unknown) => {
    if (closed || response.destroyed || response.writableEnded) return;
    if (response.writableLength > 1024 * 1024) {
      response.destroy();
      close();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const complete = (turn: typeof initial) => {
    if (turn.status === "running") return false;
    if (turn.response) send("done", turn.response);
    else
      send("error", {
        status: turn.status === "cancelled" ? 409 : 503,
        code:
          turn.errorCode ??
          (turn.status === "cancelled" ? "run_cancelled" : "execution_failed"),
        message: turn.errorMessage ?? "本轮未完成，请明确发起新消息重试",
      });
    close();
    return true;
  };
  response.once("close", close);
  send("run_started", { runId, sessionId, replayed });
  if (initial.partialAnswer)
    send("answer_reset", { text: initial.partialAnswer });
  for (const item of initial.progress) send("progress", item);
  if (complete(initial)) return;
  unsubscribe = service.subscribe(runId, ({ event, data }) => {
    send(event, data);
    if (event === "done" || event === "error") close();
  });
  timer = setInterval(() => {
    if (closed || polling) return;
    polling = true;
    void service
      .turn(principal, sessionId, runId)
      .then((turn) => {
        if (!closed) {
          if (!complete(turn)) {
            // A view may reconnect to a different API process. Replay the durable
            // projection only when this process does not own the live stream.
            if (!service.hasActive(runId)) {
              send("answer_reset", { text: turn.partialAnswer });
              for (const item of turn.progress) send("progress", item);
            }
            response.write(": keepalive\n\n");
          }
        }
      })
      .catch((error) => {
        send("error", publicIntegrationError(error));
        close();
      })
      .finally(() => {
        polling = false;
      });
  }, 2000);
  timer.unref();
}
