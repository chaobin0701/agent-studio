import type { CompositionSnapshot } from "../agent-management/runtime-scope";
import type { DeepAgentExecutionService } from "../ai/deep-agents/deep-agent-execution.service";
import type {
  PlatformAgentInput,
  PlatformAgentCallbacks,
} from "../ai/runtime/platform-input";
import type { PlatformAgentResult } from "../ai/runtime/platform-result";
import type { TaskExecutionResult } from "../ai/runtime/task-result";
import { chatTask, chatRunIds, chatContextFiles } from "./agent-chat-context";
import { transcriptMessageBase, TRANSCRIPT_VERSION } from "./agent-transcript";

/** Legacy/public Chat compatibility edge over the same native task executor.
 * Does not plan, retry, invoke another model, or grant capability permissions. */
export async function executeAgentChat(
  execution: DeepAgentExecutionService,
  composition: CompositionSnapshot,
  input: PlatformAgentInput,
  callbacks: PlatformAgentCallbacks = {},
): Promise<PlatformAgentResult> {
  const entry = composition.agents.get(composition.entryVersionId);
  if (!entry) throw new Error("Entry Agent snapshot is unavailable");
  const taskResult = await execution.runTask(
    composition,
    chatTask(composition, input),
    {
      ...chatRunIds(input),
      signal: input.signal,
      conversationId: input.conversationId,
      entryPoint: "chat",
      interactionHost:input.interactionHost,
      validateContextResource:input.validateContextResource,
      contextFiles: chatContextFiles(input, [...entry.tools.keys()]),
      validateContextFile: async (file, signal) => {
        if (!file.resource) return;
        if (!input.validateContextResource)
          throw new Error("Context freshness validator is unavailable");
        await input.validateContextResource(file.resource, signal);
      },
    },
    callbacks,
  );
  const result = projectChatResult(taskResult);
  result.contextSnapshot.entryPoint = "chat";
  result.contextSnapshot.contextMemory = input.restoredContext?.diagnostics;
  if (input.requestContext && Object.keys(input.requestContext).length)
    result.contextSnapshot.requestContext = input.requestContext;
  result.contextSnapshot.transcriptVersion = TRANSCRIPT_VERSION;
  // Only this turn's public messages are persisted for reuse. Native framework
  // tool bodies remain diagnostic data, not a future authority-bearing history.
  result.contextSnapshot.agentTranscript = [
    {
      ...transcriptMessageBase(input.conversationId, input.traceId, 1),
      role: "user",
      content: input.question,

    },
    {
      ...transcriptMessageBase(input.conversationId, input.traceId, 2),
      role: "assistant",
      content: result.result.answer,
      citationIds: result.result.citations.map((citation) => citation.chunkId),

    },
  ];
  return result;
}

function projectChatResult(task: TaskExecutionResult): PlatformAgentResult {
  const byId = new Map(task.sources.map((hit) => [hit.chunkId, hit]));
  const citations = task.output.references.flatMap((reference) => {
    const hit =
      reference.kind === "knowledge"
        ? byId.get(Number(reference.id))
        : undefined;
    return hit
      ? [
          {
            chunkId: hit.chunkId,
            documentId: hit.documentId,
            documentTitle: hit.documentTitle,
            originalFilename: hit.originalFilename,
            sourceStartLine: hit.sourceStartLine,
            sourceEndLine: hit.sourceEndLine,
          },
        ]
      : [];
  });
  const { output } = task;
  return {
    ...task,
    result: {
      ...(task.contextSnapshot.contextUsage ? { contextUsage: task.contextSnapshot.contextUsage as import("./context-governor").ModelContextUsage } : {}),
      answer: output.answer,
      refused: output.status === "refused",
      citations,
      ...(output.structured !== undefined
        ? { structured: output.structured }
        : {}),
      ...(output.artifacts.length ? { artifacts: output.artifacts } : {}),
      ...(output.references.length ? { references: output.references } : {}),
    },
    loadedSkills: [],
    answerSegments: [output.answer],
  };
}
