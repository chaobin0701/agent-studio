/** Native output failure classification, independent of any planner protocol. */
export class AgentProtocolError extends Error {
  readonly code: string;
  constructor(readonly reason: string) {
    super("Model response violates the Agent protocol");
    this.name = "AgentProtocolError";
    this.code =
      reason === "output_truncated"
        ? "model_output_truncated"
        : reason === "content_filtered"
          ? "model_content_filtered"
          : "model_protocol_error";
  }
}
