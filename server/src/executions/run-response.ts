import { uiBlocks } from "../tool-management/ui-tool";
import type { Response } from "express";
import type { AgentRunService } from "./agent-run.service";
import { publicIntegrationError } from "../integrations/quota-error";
import { InteractionWaiting } from "../interactions/contracts";

/** Both public Runs and authenticated administrative previews use this wire
 * protocol. No native state, model reasoning or tool bodies cross this edge. */
export async function runResponse(
  runs: AgentRunService,
  prepared: Awaited<ReturnType<AgentRunService["prepare"]>>,
  response: Response,
  transport: AbortController,
) {
  transport.signal.throwIfAborted();
  if (!prepared.input.stream) {
    try { return response.json(runs.publicResult(await runs.execute(prepared,transport.signal))); }
    catch(error) { if(error instanceof InteractionWaiting) return response.status(202).json({runId:error.interaction.runId,status:"waiting",interaction:error.interaction,interactions:[error.interaction]});throw error; }
  }

  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-cache, no-transform");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (
      response.destroyed ||
      response.writableEnded ||
      transport.signal.aborted
    )
      return;
    // A stalled peer must not turn framework callbacks into an unbounded queue.
    if (response.writableLength > 1024 * 1024) {
      transport.abort(new Error("Run transport backpressure exceeded"));
      response.destroy();
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("run_started", {
    runId: prepared.admission.cached?.runId ?? prepared.admission.callId,
    replayed: Boolean(prepared.admission.cached),
  });
  const heartbeat = setInterval(() => {
    if (
      !response.destroyed &&
      !response.writableEnded &&
      !transport.signal.aborted
    )
      response.write(": keepalive\n\n");
  }, 15000);
  heartbeat.unref();
  try {
    const result = await runs.execute(prepared, transport.signal, {
      onArtifact: artifact => { for(const block of uiBlocks([artifact], prepared.admission.callId)) send("tool_ui", block); },
      onAnswerDelta: (text) => send("answer_delta", { text }),
      onAnswerReset: (text) => send("answer_reset", { text }),
      onProgress: (event) =>
        send("progress", {
          type: "progress",
          id: event.id,
          stage: event.stage,
          status: event.status,
          text: event.text,
          ...(event.operationId ? { operationId: event.operationId } : {}),
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(event.resultCount !== undefined
            ? { resultCount: event.resultCount }
            : {}),
          ...(event.ok !== undefined ? { ok: event.ok } : {}),
        }),
      onCommentary: (event) =>
        send("commentary_completed", {
          id: event.id,
          type: "commentary",
          text: event.text,
        }),
      onCommentaryDelta: (event) =>
        send("commentary_delta", {
          id: event.id,
          type: "commentary",
          text: event.text,
        }),
      onRetryStatus: (event) =>
        send("retry_status", {
          type: "retry_status",
          state: event.state,
          target: event.target,
          stage: event.stage,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorCode: event.errorCode,
          errorKind: event.errorKind,
          message: event.message,
        }),
    });
    send("done", runs.publicResult(result));
  } catch (error) {
    if(error instanceof InteractionWaiting) { send("interaction_required",{runId:error.interaction.runId,interaction:error.interaction});return; }
    const failure = publicIntegrationError(error);
    send("error", { ...failure, code: failure.code ?? "execution_failed" });
  } finally {
    clearInterval(heartbeat);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}
