const INTERNAL_KEYS = new Set([
  "agent.planner",
  "agent.answer",
  "conversation.summary",
]);

/** Presentation boundary only; existing runtime bindings remain unchanged. */
export function isBusinessPrompt(prompt: {
  isPlatform?: boolean;
  promptKey?: string;
  promptType?: string;
}) {
  return (
    !prompt.isPlatform &&
    prompt.promptType !== "summary" &&
    !INTERNAL_KEYS.has(prompt.promptKey ?? "")
  );
}
