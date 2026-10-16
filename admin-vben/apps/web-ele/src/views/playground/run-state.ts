import type { EventSourceMessage } from "eventsource-parser";

export type RunResult = {
  answer: string;
  status: string;
  structured?: unknown;
  traceId: string;
  runId: string;
  artifacts: unknown[];
  references: unknown[];
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    accounting: string;
    unknownModelCalls: number;
  };
};
export type Activity = {
  id: string;
  text: string;
  status: "running" | "completed";
  stage: string;
  ok?: boolean;
  durationMs?: number;
};
export type RunState = {
  runId: string;
  replayed: boolean;
  answer: string;
  activities: Activity[];
  terminal: boolean;
  error: string;
  outputIssues?: { path: string; message: string }[];
  retry?: {
    message: string;
    state: string;
    attempt: number;
    maxAttempts: number;
  };
  result?: RunResult;
};
export const newRunState = (): RunState => ({
  runId: "",
  replayed: false,
  answer: "",
  activities: [],
  terminal: false,
  error: "",
});
const boundedText = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : "";
/** Provisional text is replaceable. Only done supplies the canonical answer and
 * ledger usage. Diagnostics are selected fields, never retained native state. */
export function applyRunEvent(state: RunState, event: EventSourceMessage) {
  if (state.terminal) return;
  const recognized = [
    "run_started",
    "answer_delta",
    "answer_reset",
    "progress",
    "retry_status",
    "done",
    "error",
  ];
  if (!recognized.includes(event.event ?? "")) return;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    throw new Error("执行事件格式异常，请查看执行记录；不会自动重放任务。");
  }
  switch (event.event) {
    case "run_started":
      state.runId = boundedText(data.runId, 128);
      state.replayed = data.replayed === true;
      break;
    case "answer_delta":
      if (
        typeof data.text !== "string" ||
        state.answer.length + data.text.length > 512 * 1024
      )
        throw new Error("实时回答超过显示上限，请查看执行记录。");
      state.answer += data.text;
      break;
    case "answer_reset":
      state.answer = boundedText(data.text, 512 * 1024);
      break;
    case "progress": {
      const id = boundedText(data.operationId ?? data.id, 256);
      if (!id || !["running", "completed"].includes(String(data.status)))
        return;
      const item: Activity = {
        id,
        text: boundedText(data.text, 500),
        stage: boundedText(data.stage, 32),
        status: data.status as Activity["status"],
        ...(typeof data.ok === "boolean" ? { ok: data.ok } : {}),
        ...(typeof data.durationMs === "number" &&
        Number.isFinite(data.durationMs)
          ? { durationMs: data.durationMs }
          : {}),
      };
      const index = state.activities.findIndex((item) => item.id === id);
      if (index >= 0) state.activities[index] = item;
      else state.activities.push(item);
      state.activities = state.activities.slice(-60);
      break;
    }
    case "retry_status":
      state.retry = {
        message: boundedText(data.message, 500),
        state: boundedText(data.state, 32),
        attempt: Number(data.attempt) || 0,
        maxAttempts: Number(data.maxAttempts) || 0,
      };
      break;
    case "error":
      state.outputIssues = Array.isArray(data.issues)
        ? data.issues
            .filter(
              (i: any) =>
                i &&
                typeof i.path === "string" &&
                typeof i.message === "string",
            )
            .slice(0, 12)
            .map((i: any) => ({
              path: i.path.slice(0, 240),
              message: i.message.slice(0, 240),
            }))
        : undefined;
      state.error =
        boundedText(data.message, 500) || "任务未完成，请查看执行记录。";
      state.terminal = true;
      break;
    case "done":
      if (
        typeof data.answer !== "string" ||
        typeof data.runId !== "string" ||
        typeof data.traceId !== "string" ||
        !["completed", "refused"].includes(String(data.status)) ||
        !Array.isArray(data.artifacts) ||
        !Array.isArray(data.references)
      )
        throw new Error("最终结果格式异常，请查看执行记录。");
      state.result = data as RunResult;
      state.runId = data.runId;
      state.answer = data.answer;
      state.terminal = true;
      break;
  }
}
