import { accountCredential, type AccountCredential } from '../model-management/account-credential';
import type { DatabaseService } from '../database.service';
import type { AppConfigService } from '../config/config.service';
import { SecretBox } from '../security/secret-box';
import { currentWorkspaceId } from '../workspaces/workspace-context';
import { embeddingFingerprint, embeddingProfileSchema, embedWithProfile, validateProfileEndpoint, type EmbeddingProfile } from './profile-embedding';
import { executionSpan, annotateExecution } from '../observability/execution-tracer';

type QuerySource = Pick<DatabaseService, 'query'>;

/** Snapshots freeze the vector space, not credentials. Key rotation is read
 * from the same profile on every call and never changes the stored vectors. */
export async function resolveEmbeddingCredential(database: QuerySource, runtime: AppConfigService, profile: EmbeddingProfile): Promise<{ apiKey: string }> {
  if (!profile.profileId) {
    if(currentWorkspaceId()!==1) throw new Error('Embedding requires a model account in this workspace');
    validateProfileEndpoint(profile, runtime);
    const connection = profile.secretRef === 'default' ? runtime.embedding : runtime.embedding.connections?.[profile.secretRef];
    if (!connection?.apiKey) throw new Error('Embedding credential is not configured');
    return { apiKey: connection.apiKey };
  }
  const row = (await database.query<{ config: unknown; api_key_ciphertext: string | null; model_account_id?:number|null }>(
    'SELECT config,api_key_ciphertext,model_account_id FROM embedding_profiles WHERE id=$1', [profile.profileId])).rows[0];
  if (!row) throw new Error('Embedding profile is unavailable');
  const current = embeddingProfileSchema.parse(row.config);
  if (embeddingFingerprint(current) !== embeddingFingerprint(profile)
    || (profile.fingerprint && profile.fingerprint !== embeddingFingerprint(profile))) throw new Error('Embedding vector space changed; rebuild the index');
  if (row.model_account_id) {
    const account = (await database.query<AccountCredential>('SELECT base_url,api_key_ciphertext,secret_ref,enabled FROM model_accounts WHERE id=$1 AND kind=\'embedding\'', [row.model_account_id])).rows[0];
    if (!account || account.base_url.replace(/\/+$/, '') !== profile.baseUrl.replace(/\/+$/, '')) throw new Error('Embedding account endpoint changed');
    return { apiKey: accountCredential(account, runtime) };
  }
  if (row.api_key_ciphertext) return { apiKey: new SecretBox(runtime).decrypt(row.api_key_ciphertext) };
  if(currentWorkspaceId()!==1) throw new Error('Embedding requires a model account in this workspace');
  validateProfileEndpoint(profile, runtime);
  const connection = profile.secretRef === 'default' ? runtime.embedding : runtime.embedding.connections?.[profile.secretRef];
  if (!connection?.apiKey) throw new Error('Embedding credential is not configured');
  return { apiKey: connection.apiKey };
}

export async function embedForProfile(database: QuerySource, runtime: AppConfigService, profile: EmbeddingProfile, inputs: string[], signal?:AbortSignal) {
  return executionSpan('query_embedding','embedding',{provider:profile.provider,modelName:profile.model},async()=>{
    signal?.throwIfAborted();
    const credential = await resolveEmbeddingCredential(database, runtime, profile);
    signal?.throwIfAborted();
    const vectors=await embedWithProfile(profile, inputs, runtime, credential,signal);
    annotateExecution({embeddingCalls:Math.ceil(inputs.length/(profile.provider==='volcengine-multimodal'?1:profile.batchSize))});
    return vectors;
  });
}
