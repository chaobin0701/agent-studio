import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";

export type RecordingPolicy = {
  auditEnabled: boolean;
  conversationContentEnabled: boolean;
  traceEnabled: boolean;
  usageEnabled: boolean;
};

export const DEFAULT_RECORDING_POLICY: RecordingPolicy = {
  auditEnabled: true,
  // Preserve pre-policy behavior in tests and services instantiated without the module.
  // A migrated production database uses the explicit table default (false).
  conversationContentEnabled: true,
  traceEnabled: true,
  usageEnabled: true,
};

@Injectable()
export class RecordingPolicyService {
  constructor(private readonly db: DatabaseService) {}

  async current(): Promise<RecordingPolicy> {
    const { rows } = await this.db.platformQuery<RecordingPolicy>(`SELECT audit_enabled AS "auditEnabled",
      conversation_content_enabled AS "conversationContentEnabled",trace_enabled AS "traceEnabled",
      usage_enabled AS "usageEnabled" FROM system_mcp_recording_policy WHERE id=1`);
    return rows[0] ?? DEFAULT_RECORDING_POLICY;
  }
}
