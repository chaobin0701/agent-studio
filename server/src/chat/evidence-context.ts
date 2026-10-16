import type { AgentTranscriptMessage } from "./agent-transcript";

/** Keep native call/result pairs while the governed evidence set owns the only result body. */
export function projectEvidenceTranscript(
  transcript: AgentTranscriptMessage[],
  evidenceIds: ReadonlySet<number>,
): AgentTranscriptMessage[] {
  const calls = new Map(
    transcript.flatMap((m) =>
      (m.toolCalls ?? []).map((call) => [call.id, call] as const),
    ),
  );
  return transcript.map((message) => {
    if (
      message.role === "tool" &&
      message.toolCallId &&
      ["delegate_agent", "run_skill"].includes(
        calls.get(message.toolCallId)?.name ?? "",
      )
    )
      return {
        ...message,
        content: JSON.stringify({
          note: "历史专项任务已结束；本轮请使用当前恢复的资料或重新执行专项任务。",
        }),
      };
    if (
      message.role !== "tool" ||
      !message.toolCallId ||
      calls.get(message.toolCallId)?.name !== "search_knowledge"
    )
      return message;
    try {
      const result = JSON.parse(message.content ?? "{}");
      // Explicit capability references wrap data in an owned `result` slot.
      // Historical retrieval bodies must be projected regardless of that wire
      // encoding; otherwise archived/deleted evidence leaks through raw replay.
      const data =
        result &&
        typeof result.result === "object" &&
        result.result !== null &&
        !Array.isArray(result.result)
          ? result.result
          : result;
      if (result?.error || data?.error)
        return {
          ...message,
          content: JSON.stringify({ error: "historical_retrieval_failed" }),
        };
      const ids: number[] = (Array.isArray(data?.hits) ? data.hits : [])
        .map((hit: { chunkId?: number }) => hit?.chunkId)
        .filter((id: unknown): id is number => Number.isSafeInteger(id));
      return {
        ...message,
        content: JSON.stringify({
          evidenceRefs: ids.filter((id) => evidenceIds.has(id)),
          unavailableEvidenceIds: ids.filter((id) => !evidenceIds.has(id)),
          detailLocation: "initialEvidence",
          note: "仅本轮提供的片段可作为当前资料；历史片段未恢复时可补充检索",
        }),
      };
    } catch {
      return {
        ...message,
        content: JSON.stringify({
          note: "历史检索结果无法验证，本轮需重新检索。",
        }),
      };
    }
  });
}
