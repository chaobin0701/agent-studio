import { Injectable } from "@nestjs/common";
import type { DatabaseService } from "../database.service";
import { PromptService } from "./prompt.service";
import type { PromptVariableMap } from "./prompt.types";

export type PromptRuntimeEntry = {
  key: string;
  resourceId: number | null;
  versionId: number | null;
  version: number | null;
  template: string;
  variables: PromptVariableMap;
  environment: "dev" | "test" | "prod";
  source: "managed" | "fallback";
};

export type PromptRuntimeSnapshot = {
  environment: "dev" | "test" | "prod";
  businessPrompt?: string;
  delegationHints?: string;
  prompts: Record<string, PromptRuntimeEntry>;
};

@Injectable()
export class PromptRuntimeService {
  // Preserve the DI contract for integrations; no internal template reads.
  constructor(_prompts: PromptService) {}

  async snapshot(
    environment: PromptRuntimeSnapshot["environment"] = this.environment(),
    _query?: Pick<DatabaseService, "query">,
  ): Promise<PromptRuntimeSnapshot> {
    // AgentManagement adds the immutable business version inside its transaction.
    // Legacy requests use code-owned defaults, not environment-bound Keys.
    return Object.freeze({ environment, prompts: Object.freeze({}) });
  }

  metadata(snapshot: PromptRuntimeSnapshot): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(snapshot.prompts).map(([key, entry]) => [
        key,
        {
          promptKey: entry.key,
          resourceId: entry.resourceId,
          versionId: entry.versionId,
          version: entry.version,
          source: entry.source,
        },
      ]),
    );
  }

  private environment(): PromptRuntimeSnapshot["environment"] {
    const configured = process.env.PROMPT_ENV?.trim().toLowerCase();
    if (configured === "prod" || configured === "test" || configured === "dev")
      return configured;
    if (process.env.NODE_ENV === "production") return "prod";
    if (process.env.NODE_ENV === "test") return "test";
    return "dev";
  }
}
