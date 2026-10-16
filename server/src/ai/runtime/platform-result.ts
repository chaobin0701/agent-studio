import type { ChatAnswer } from "../../chat/chat.service";
import type { SkillSummary } from "../skills/skill.types";
import type { TaskExecutionResult } from "./task-result";

/** Existing Chat envelope only. Formal stateless tasks return TaskExecutionResult. */
export type PlatformAgentResult = TaskExecutionResult &
  {
    result: ChatAnswer;
    loadedSkills: SkillSummary[];
    /** Canonical buffered fragments for non-live consumers; SSE uses callbacks during generation. */
    answerSegments?: string[];
  };
