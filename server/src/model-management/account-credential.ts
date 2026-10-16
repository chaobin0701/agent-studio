import type { AppConfigService } from "../config/config.service";
import { SecretBox } from "../security/secret-box";
import { currentWorkspaceId } from '../workspaces/workspace-context';
export type AccountCredential = {
  base_url: string;
  api_key_ciphertext: string | null;
  secret_ref: string | null;
  enabled: boolean;
};
/** Credentials can rotate; account endpoint identity never changes. */
export function accountCredential(
  row: AccountCredential,
  runtime: AppConfigService,
): string {
  if (!row.enabled) throw new Error("Model account is disabled");
  if (row.api_key_ciphertext)
    return new SecretBox(runtime).decrypt(row.api_key_ciphertext);
  if(currentWorkspaceId()!==1) throw new Error('Model requires a credential in this workspace');
  const connection =
    row.secret_ref === "llm"
      ? runtime.llm
      : row.secret_ref?.startsWith("embedding:")
        ? row.secret_ref === "embedding:default"
          ? runtime.embedding
          : runtime.embedding.connections?.[row.secret_ref.slice(10)]
        : undefined;
  if (
    !connection?.apiKey ||
    connection.baseUrl.replace(/\/+$/, "") !== row.base_url.replace(/\/+$/, "")
  )
    throw new Error("Model account credential must match its bound endpoint");
  return connection.apiKey;
}
