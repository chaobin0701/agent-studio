import { effectiveAgentVersion } from '../agent-management/effective-agent-version';
import { lifecycleWriteLock } from '../agent-management/resource-lifecycle';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { compare } from 'bcryptjs';
import { createHash } from "node:crypto";
import { currentWorkspaceId } from '../workspaces/workspace-context';
import { z } from "zod";
import { CredentialAccess, credentialPreview } from './credential-access';
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import { AppConfigService } from "../config/config.service";
import { normalizeModelBaseUrl } from '../config/model-base-url';
import { SecretBox } from "../security/secret-box";
import { LangChainOpenAIProvider } from "../ai/providers/langchain-openai.provider";
import { ProviderError } from "../ai/providers/provider-errors";
import {
  embeddingFingerprint,
  embeddingProfileSchema,
  embedWithProfile,
  EmbeddingDimensionError,
  EmbeddingRequestError,
} from "../documents/profile-embedding";
import { getLlmPlatformPreset } from "../ai/providers/llm-platforms";
import {
  accountCredential,
  type AccountCredential,
} from "./account-credential";
import {
  accountSchema,
  llmDeploymentSchema,
  embeddingDeploymentSchema,
  type ModelKind,
  type PlanConfig,
  type PlanVersion,
  type DeploymentSnapshot,
} from "./model-management.types";

type Query = Pick<DatabaseService, "query">;
type AccountRow = AccountCredential & {
  id: number;
  name: string;
  platform_key: string;
  key_revision: number;
  deleted_at?:Date|null;
  archived_at?:Date|null;
};
const selectionSchema = z
  .object({
    deploymentIds: z.array(z.number().int().positive()).min(1).max(4),
    revision: z.number().int().positive().optional(),
  })
  .strict();
const lockSql = "SELECT pg_advisory_xact_lock(351035)";

@Injectable()
export class ModelManagementService implements OnModuleInit {
  private readonly credentialAccess = new CredentialAccess();
  private readonly workspacePlans = new Map<number,PlanVersion|null>();
  get currentPlan():PlanVersion|null { return this.workspacePlans.get(currentWorkspaceId())??null; }
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: AppConfigService,
    private readonly secrets: SecretBox,
  ) {}
  private input<T>(schema: z.ZodType<T>, value: unknown): T {
    const p = schema.safeParse(value);
    if (!p.success)
      throw new BadRequestException(
        p.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    return p.data;
  }
  private async write<T>(
    actor: number,
    action: string,
    target: string,
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (c) => {
      await lifecycleWriteLock(c);
      await c.query(lockSql);
      const result = await work(c);
      await c.query(
        "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id) VALUES($1,$2,'model_management',$3)",
        [actor, action, target],
      );
      return result;
    });
  }
  async onModuleInit() {
    // Import an environment-only model into an empty library once. Removed
    // resources still count: a restart must not undo an administrator's removal.
    await this.database.transaction(async (c) => {
      await lifecycleWriteLock(c);
      await c.query(lockSql);
      if (
        (
          await c.query(
            "SELECT 1 FROM model_bindings WHERE purpose='default' LIMIT 1",
          )
        ).rowCount
      )
        return;
      if ((await c.query("SELECT 1 FROM model_accounts WHERE kind='llm' LIMIT 1")).rowCount) return;
      const llm = this.runtime.llm;
      if (!llm.apiKey) return;
      const a = (
        await c.query(
          "INSERT INTO model_accounts(kind,name,platform_key,base_url,secret_ref) VALUES('llm','环境模型账户','custom',$1,'llm') RETURNING id::int",
          [llm.baseUrl],
        )
      ).rows[0];
      const config = this.input(llmDeploymentSchema, {
        provider: llm.provider,
        model: llm.model,
        timeoutMs: llm.timeoutMs,
        contextWindowTokens: llm.contextWindowTokens,
        maxOutputTokens: llm.maxOutputTokens,
        maxRetries: 3,
      });
      const d = (
        await c.query(
          "INSERT INTO model_deployments(kind,name,account_id,config) VALUES('llm','环境模型部署',$1,$2) RETURNING id::int",
          [a.id, JSON.stringify(config)],
        )
      ).rows[0];
      const p = (
        await c.query(
          "INSERT INTO model_plans(kind,name) VALUES('llm','默认模型方案') RETURNING id::int",
        )
      ).rows[0];
      const snapshot: PlanConfig = {
        deployments: [
          {
            id: d.id,
            accountId: a.id,
            name: "环境模型部署",
            baseUrl: llm.baseUrl,
            config,
          },
        ],
        migrated: true,
      };
      const v = (
        await c.query(
          "INSERT INTO model_plan_versions(plan_id,version,status,config,published_at) VALUES($1,1,'published',$2,now()) RETURNING id::int",
          [p.id, JSON.stringify(snapshot)],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO model_bindings(purpose,version_id) VALUES('default',$1)",
        [v.id],
      );
    });
    await this.activePlan();
  }
  async list(kind: ModelKind, includeRemoved = false) {
    const accounts = (
      await this.database.query<AccountRow>(
        "SELECT id::int,name,platform_key,base_url,api_key_ciphertext,secret_ref,enabled,key_revision,deleted_at,archived_at FROM model_accounts WHERE kind=$1 AND ($2 OR deleted_at IS NULL AND archived_at IS NULL) ORDER BY id",
        [kind, includeRemoved],
      )
    ).rows;
    const deployments = (
      await this.database.query(
        "SELECT id::int,name,account_id::int,config,enabled,deleted_at,archived_at,test_result,tested_at FROM model_deployments WHERE kind=$1 AND ($2 OR deleted_at IS NULL AND archived_at IS NULL) ORDER BY id",
        [kind, includeRemoved],
      )
    ).rows;
    const versions = (
      await this.database.query(
        `SELECT v.id::int,v.plan_id::int,v.version,v.status,v.config,v.revision,v.test_signature,v.test_result,v.tested_at,v.published_at,p.name,
   b.version_id IS NOT NULL AS active,e.id::int AS embedding_profile_id
   FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id
   LEFT JOIN model_bindings b ON b.version_id=v.id LEFT JOIN embedding_profiles e ON e.model_plan_version_id=v.id
   WHERE p.kind=$1 AND ($2 OR p.deleted_at IS NULL AND p.archived_at IS NULL) ORDER BY p.id,v.version DESC`,
        [kind, includeRemoved],
      )
    ).rows;
    for (const v of versions) {
      if (v.status !== "draft" || !v.test_result) continue;
      try {
        v.test_stale =
          v.test_signature !==
          (await this.signature(this.database, { ...v, kind } as PlanVersion));
      } catch {
        v.test_stale = true;
      }
      if (v.test_stale) v.test_result = null;
    }
    for (const v of versions) delete v.test_signature;
    const usage =
      kind === "embedding"
        ? (
            await this.database.query(`
      SELECT e.model_plan_version_id::int AS version_id,kb.id::int,kb.name,kb.archived_at IS NOT NULL AS archived,
       (kb.draft_config->>'embeddingProfileId')::bigint=e.id AS configured,
       EXISTS(SELECT 1 FROM knowledge_index_versions i WHERE i.id=kb.active_index_version_id AND ((i.embedding_snapshot->>'profileId')::bigint=e.id OR (i.config->>'embeddingProfileId')::bigint=e.id)) AS active,
       EXISTS(SELECT 1 FROM knowledge_index_versions i WHERE i.knowledge_base_id=kb.id AND ((i.embedding_snapshot->>'profileId')::bigint=e.id OR (i.config->>'embeddingProfileId')::bigint=e.id)) AS historical
      FROM embedding_profiles e JOIN knowledge_bases kb ON (kb.draft_config->>'embeddingProfileId')::bigint=e.id
       OR EXISTS(SELECT 1 FROM knowledge_index_versions i WHERE i.knowledge_base_id=kb.id AND ((i.embedding_snapshot->>'profileId')::bigint=e.id OR (i.config->>'embeddingProfileId')::bigint=e.id))
       OR EXISTS(SELECT 1 FROM documents d JOIN document_chunks c ON c.document_id=d.id WHERE d.knowledge_base_id=kb.id AND c.embedding_profile_id=e.id)
      WHERE e.model_plan_version_id IS NOT NULL ORDER BY kb.id`)
          ).rows
        : [];
    for (const v of versions)
      v.knowledge_bases = usage
        .filter((k) => k.version_id === v.id)
        .map(({ version_id, ...kb }) => kb);
    return {
      kind,
      platforms: (["volcengine", "openai", "deepseek", "custom"] as const)
        .filter(key => kind !== "embedding" || key !== "deepseek")
        .map(key => getLlmPlatformPreset(key)),
      accounts: accounts.map(({ api_key_ciphertext, secret_ref, ...a }) => ({
        ...a,
        keySource: api_key_ciphertext ? "managed" : secret_ref ? "environment" : "missing",
        apiKeyPreview: this.preview({ ...a,api_key_ciphertext,secret_ref }),
      })),
      deployments,
      versions,
      plans: (await this.database.query(`SELECT id::int,name,current_version_id::int,deleted_at,archived_at FROM model_plans
        WHERE kind=$1 AND ($2 OR deleted_at IS NULL AND archived_at IS NULL) ORDER BY id`,[kind,includeRemoved])).rows,
    };
  }
  private preview(a:AccountCredential) {
    try { return credentialPreview(accountCredential({...a,enabled:true},this.runtime)); }
    catch { return a.api_key_ciphertext || a.secret_ref ? '凭据不可读取' : '待配置密钥'; }
  }
  private credentialScope(actor:number,kind:ModelKind,a:AccountRow) {
    return `${currentWorkspaceId()}:${actor}:${kind}:${a.id}:${a.key_revision}`;
  }
  async unlockCredential(actor:number,kind:ModelKind,id:number,body:unknown) {
    const {password}=this.input(z.object({password:z.string().min(1).max(200)}).strict(),body);
    const attemptScope=`${currentWorkspaceId()}:${actor}`;
    this.credentialAccess.checkAttempts(attemptScope);
    const a=await this.account(this.database,kind,id);
    if(a.deleted_at || a.archived_at)throw new BadRequestException('请先恢复账户，再查看凭据');
    if(!a.api_key_ciphertext)throw new BadRequestException('环境凭据请在部署配置中维护，不提供明文查看');
    const admin=(await this.database.platformQuery<{password_hash:string;disabled_at:Date|null}>('SELECT password_hash,disabled_at FROM admins WHERE id=$1',[actor])).rows[0];
    if(!admin || admin.disabled_at || !(await compare(password,admin.password_hash))) {
      this.credentialAccess.failed(attemptScope);
      throw new BadRequestException('身份验证失败');
    }
    this.credentialAccess.succeeded(attemptScope);
    await this.write(actor,'model_credential.authorized',String(id),async()=>undefined);
    return this.credentialAccess.grant(this.credentialScope(actor,kind,a));
  }
  async revealCredential(actor:number,kind:ModelKind,id:number,body:unknown) {
    const input=this.input(z.object({token:z.string().min(20).max(100),action:z.enum(['view','copy'])}).strict(),body);
    return this.write(actor,`model_credential.${input.action}`,String(id),async c=> {
      const a=await this.account(c,kind,id);
      if(a.deleted_at || a.archived_at)throw new BadRequestException('请先恢复账户，再查看凭据');
      this.credentialAccess.verify(input.token,this.credentialScope(actor,kind,a));
      if(!a.api_key_ciphertext)throw new BadRequestException('环境凭据不提供明文查看');
      return {apiKey:this.secrets.decrypt(a.api_key_ciphertext)};
    });
  }
  async references(kind:ModelKind,type:'accounts'|'deployments'|'plans',id:number,db:Query=this.database) {
    const refs:{type:string;id:number;name:string;usage:string}[]=[];
    if(type==='accounts') {
      refs.push(...(await db.query(`SELECT 'deployment' AS type,id::int,name,
        CASE WHEN deleted_at IS NULL AND archived_at IS NULL THEN 'current' ELSE 'historical' END AS usage
        FROM model_deployments WHERE account_id=$1 AND kind=$2`,[id,kind])).rows as typeof refs);
    }
    const versions=(await db.query(`SELECT v.id::int,v.plan_id::int,p.name,v.status,
      p.deleted_at,p.archived_at,p.current_version_id::int
      FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE p.kind=$1 AND
      ($2='plans' AND p.id=$3 OR $2<>'plans' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.config->'deployments') d
        WHERE (d->>CASE WHEN $2='accounts' THEN 'accountId' ELSE 'id' END)::bigint=$3))`,[kind,type,id])).rows;
    if(type!=='plans') refs.push(...versions.map(v=>({type:'plan',id:v.plan_id,name:`${v.name} · ${v.status==='draft'?'草稿':'发布记录'}`,
      usage:!v.deleted_at&&!v.archived_at&&(v.status==='draft'||v.current_version_id===v.id)?'current':'historical'})));
    const ids=versions.map(v=>v.id);
    if(ids.length) {
      refs.push(...(await db.query(`SELECT 'agent' AS type,r.id::int,r.name,
        CASE WHEN r.archived_at IS NULL AND r.deleted_at IS NULL AND (v.status='draft' OR ${effectiveAgentVersion('r','v')}) THEN 'current' ELSE 'historical' END AS usage
        FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id
        WHERE r.kind='agent' AND ((v.config->>'modelPlanVersionId')::bigint=ANY($1::bigint[]) OR (v.config->>'embeddingPlanVersionId')::bigint=ANY($1::bigint[]))`,[ids])).rows as typeof refs);
      refs.push(...(await db.query(`SELECT 'binding' AS type,version_id::int AS id,'旧默认模型选择（移除时自动解除）' AS name,'automatic' AS usage
        FROM model_bindings WHERE version_id=ANY($1::bigint[])`,[ids])).rows as typeof refs);
      if(kind==='embedding') {
        refs.push(...(await db.query(`SELECT 'workspace' AS type,id::int,name,'current' AS usage FROM workspaces
          WHERE id=current_workspace_id() AND default_embedding_plan_version_id=ANY($1::bigint[])`,[ids])).rows as typeof refs);
        refs.push(...(await db.query(`SELECT DISTINCT 'knowledge' AS type,kb.id::int,kb.name,
          CASE WHEN kb.archived_at IS NULL AND ((kb.draft_config->>'embeddingProfileId')::bigint=e.id
            OR EXISTS(SELECT 1 FROM knowledge_index_versions i WHERE i.id=kb.active_index_version_id AND
              ((i.embedding_snapshot->>'profileId')::bigint=e.id OR (i.config->>'embeddingProfileId')::bigint=e.id)))
            THEN 'current' ELSE 'historical' END AS usage
          FROM embedding_profiles e JOIN knowledge_bases kb ON (kb.draft_config->>'embeddingProfileId')::bigint=e.id
            OR EXISTS(SELECT 1 FROM knowledge_index_versions i WHERE i.knowledge_base_id=kb.id AND
              ((i.embedding_snapshot->>'profileId')::bigint=e.id OR (i.config->>'embeddingProfileId')::bigint=e.id))
            OR EXISTS(SELECT 1 FROM documents d JOIN document_chunks c ON c.document_id=d.id WHERE d.knowledge_base_id=kb.id AND c.embedding_profile_id=e.id)
          WHERE e.model_plan_version_id=ANY($1::bigint[])`,[ids])).rows as typeof refs);
      }
    }
    return [...new Map(refs.map(ref=>[`${ref.type}:${ref.id}:${ref.usage}`,ref])).values()];
  }
  async remove(actor:number,kind:ModelKind,type:'accounts'|'deployments'|'plans',id:number) {
    const table={accounts:'model_accounts',deployments:'model_deployments',plans:'model_plans'}[type];
    const result=await this.write(actor,'model_resource.removed',`${type}:${id}`,async c=>{
      if(!(await c.query(`SELECT id FROM ${table} WHERE id=$1 AND kind=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`,[id,kind])).rowCount)
        throw new NotFoundException('资源不存在或已移除');
      const refs=await this.references(kind,type,id,c);
      if(refs.some(r=>r.usage==='current'))throw new ConflictException({message:'仍有当前配置引用，请先替换或解除关联',references:refs});
      const defaults=refs.filter(r=>r.type==='binding'&&r.usage==='automatic').map(r=>r.id);
      if(defaults.length){
        await c.query('DELETE FROM model_bindings WHERE version_id=ANY($1::bigint[])',[defaults]);
        await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'model_binding.cleared','model_management',$2,$3)",[actor,`${type}:${id}`,JSON.stringify({versionIds:defaults,reason:'resource_removed'})]);
      }
      const archived=refs.some(r=>r.usage==='historical');
      await c.query(`UPDATE ${table} SET ${archived?'archived_at':'deleted_at'}=now() WHERE id=$1 AND kind=$2`,[id,kind]);
      return {ok:true,archived,defaultCleared:defaults.length>0,references:refs};
    });
    // Mutate the process cache only after the transaction (including audit) commits.
    if(kind==='llm' && result.defaultCleared)this.workspacePlans.delete(currentWorkspaceId());
    return result;
  }
  async restore(actor:number,kind:ModelKind,type:'accounts'|'deployments'|'plans',id:number) {
    const table={accounts:'model_accounts',deployments:'model_deployments',plans:'model_plans'}[type];
    return this.write(actor,'model_resource.restored',`${type}:${id}`,async c=>{
      const row=(await c.query(`UPDATE ${table} SET deleted_at=NULL,archived_at=NULL WHERE id=$1 AND kind=$2
        AND (deleted_at IS NOT NULL OR archived_at IS NOT NULL) RETURNING id::int`,[id,kind])).rows[0];
      if(!row)throw new NotFoundException('可恢复的资源不存在');
      return row;
    });
  }
  async workingDraft(actor:number,kind:ModelKind,planId:number,body:unknown) {
    const input=this.input(z.object({fromVersionId:z.number().int().positive().optional(),branch:z.boolean().default(false)}).strict(),body??{});
    return this.write(actor,'model_plan.draft_prepared',String(planId),async c=>{
      const plan=(await c.query('SELECT id,current_version_id::int FROM model_plans WHERE id=$1 AND kind=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE',[planId,kind])).rows[0];
      if(!plan)throw new NotFoundException('模型方案不存在或已移除');
      const versions=(await c.query('SELECT id::int,status FROM model_plan_versions WHERE plan_id=$1 ORDER BY version DESC',[planId])).rows;
      if(input.fromVersionId&&!versions.some(v=>v.id===input.fromVersionId))throw new BadRequestException('来源版本不属于此模型方案');
      const draft=versions.find(v=>v.status==='draft');
      if(draft&&!input.branch)return {versionId:draft.id,reused:true};
      const sourceId=input.fromVersionId??plan.current_version_id??versions.find(v=>v.status==='published')?.id;
      if(!sourceId)throw new ConflictException('方案没有可编辑的来源版本');
      const source=await this.version(c,kind,sourceId);
      const created=(await c.query('INSERT INTO model_plan_versions(plan_id,version,config) SELECT $1,COALESCE(MAX(version),0)+1,$2 FROM model_plan_versions WHERE plan_id=$1 RETURNING id::int',[planId,JSON.stringify(source.config)])).rows[0];
      return {versionId:created.id,reused:false};
    });
  }
  async rollbackPlan(actor:number,kind:ModelKind,planId:number,body:unknown) {
    const input=this.input(z.object({versionId:z.number().int().positive(),expectedCurrentVersionId:z.number().int().positive().nullable()}).strict(),body);
    return this.write(actor,'model_plan.rolled_back',String(planId),async c=>{
      const plan=(await c.query('SELECT current_version_id::int FROM model_plans WHERE id=$1 AND kind=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE',[planId,kind])).rows[0];
      if(!plan)throw new NotFoundException('模型方案不存在或已移除');
      if(plan.current_version_id!==input.expectedCurrentVersionId)throw new ConflictException('当前发布版本已变化，请刷新后回滚');
      const version=await this.version(c,kind,input.versionId);
      if(version.plan_id!==planId||version.status!=='published')throw new BadRequestException('只能恢复本方案的已发布版本');
      await this.signature(c,version);
      if(kind==='embedding'&&!(await c.query('SELECT id FROM embedding_profiles WHERE model_plan_version_id=$1 AND enabled',[version.id])).rowCount)throw new ConflictException('该向量版本已不可用');
      await c.query('UPDATE model_plans SET current_version_id=$2 WHERE id=$1',[planId,version.id]);
      if(kind==='llm')await c.query(`UPDATE model_bindings b SET version_id=$2,updated_at=now() FROM model_plan_versions old
        WHERE old.id=b.version_id AND old.plan_id=$1`,[planId,version.id]);
      return {ok:true,currentVersionId:version.id};
    });
  }
  async savePlanDraft(actor:number,kind:ModelKind,planId:number,body:unknown) {
    // Old explicit-save clients retain refresh semantics. Autosave clients must
    // opt out so renaming/reordering cannot silently upgrade a pinned deployment.
    const input=this.input(selectionSchema.extend({sourceVersionId:z.number().int().positive(),revision:z.number().int().positive(),name:accountSchema.shape.name,refreshDeployments:z.boolean().default(true)}).strict(),body);
    return this.write(actor,'model_plan.edited',String(planId),async c=>{
      const p=(await c.query('SELECT id,current_version_id::int FROM model_plans WHERE id=$1 AND kind=$2 AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE',[planId,kind])).rows[0];
      if(!p)throw new NotFoundException('模型方案不存在');
      const source=await this.version(c,kind,input.sourceVersionId);
      if(source.plan_id!==planId)throw new BadRequestException('配置不属于此方案');
      const draft=(await c.query("SELECT id::int FROM model_plan_versions WHERE plan_id=$1 AND status='draft' ORDER BY version DESC LIMIT 1",[planId])).rows[0];
      if(source.status==='published'&&source.id!==p.current_version_id)throw new ConflictException('生效配置已更新，请刷新后编辑');
      if(source.revision!==input.revision || draft&&draft.id!==source.id)throw new ConflictException('已有更新草稿，请刷新后编辑');
      const latest=await this.snapshot(c,kind,input.deploymentIds);
      const config:PlanConfig={deployments:latest.deployments.map(d=>input.refreshDeployments?d:source.config.deployments.find(old=>old.id===d.id)??d)};
      let id=source.id;
      if(source.status==='published') {
        id=(await c.query("INSERT INTO model_plan_versions(plan_id,version,config) SELECT $1,COALESCE(MAX(version),0)+1,$2 FROM model_plan_versions WHERE plan_id=$1 RETURNING id::int",[planId,JSON.stringify(config)])).rows[0].id;
      } else await c.query('UPDATE model_plan_versions SET config=$2,revision=revision+1,test_signature=NULL,test_result=NULL,tested_at=NULL WHERE id=$1',[id,JSON.stringify(config)]);
      await c.query('UPDATE model_plans SET name=$2 WHERE id=$1',[planId,input.name]);
      return this.version(c,kind,id);
    });
  }
  async testAndPublish(actor:number,kind:ModelKind,id:number) {
    const v=await this.version(this.database,kind,id);
    if(v.status!=='draft')throw new ConflictException('当前配置已发布');
    const result=await this.testVersion(actor,kind,id);
    if(!result.ok)return {...result,published:false};
    await this.publish(actor,kind,id,v.revision);
    return {...result,published:true};
  }
  private endpoint(kind: ModelKind, platform: string, value: string) {
    if (kind === "embedding" && platform === "deepseek")
      throw new BadRequestException("该平台未注册向量适配器");
    try {
      return normalizeModelBaseUrl(value);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
  async createAccount(actor: number, kind: ModelKind, body: unknown) {
    const input = this.input(accountSchema, body);
    const url = this.endpoint(kind, input.platformKey, input.baseUrl);
    return this.write(
      actor,
      "model_account.created",
      kind,
      async (c) =>
        (
          await c.query(
            "INSERT INTO model_accounts(kind,name,platform_key,base_url,api_key_ciphertext) VALUES($1,$2,$3,$4,$5) RETURNING id::int",
            [
              kind,
              input.name,
              input.platformKey,
              url,
              this.secrets.encrypt(input.apiKey),
            ],
          )
        ).rows[0],
    );
  }
  async updateAccount(
    actor: number,
    kind: ModelKind,
    id: number,
    body: unknown,
  ) {
    const input = this.input(
      z
        .object({
          name: accountSchema.shape.name.optional(),
          apiKey: accountSchema.shape.apiKey.optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
      body,
    );
    return this.write(actor, "model_account.updated", String(id), async (c) => {
      const account=await this.account(c, kind, id);
      if(input.enabled===true&&!input.apiKey&&!account.api_key_ciphertext&&!account.secret_ref)
        throw new BadRequestException('请先配置供应商密钥，再启用供应商');
      if (input.enabled === false)
        await this.assertUnused(c, kind, "accountId", id);
      await c.query(
        `UPDATE model_accounts SET name=COALESCE($3,name),api_key_ciphertext=COALESCE($4,api_key_ciphertext),
    secret_ref=CASE WHEN $4::text IS NULL THEN secret_ref ELSE NULL END,key_revision=key_revision+CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END,enabled=COALESCE($5,enabled) WHERE id=$1 AND kind=$2`,
        [
          id,
          kind,
          input.name ?? null,
          input.apiKey ? this.secrets.encrypt(input.apiKey) : null,
          input.enabled ?? null,
        ],
      );
      if(input.apiKey)await c.query('UPDATE model_deployments SET test_result=NULL,tested_at=NULL WHERE account_id=$1',[id]);
      return { ok: true };
    });
  }
  async listModels(
    kind: ModelKind,
    id: number,
  ): Promise<{ available: boolean; models: string[]; message?: string }> {
    try {
      const account = await this.account(this.database, kind, id);
      const credential = accountCredential(account, this.runtime);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try {
        response = await fetch(`${account.base_url.replace(/\/+$/, "")}/models`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential}`,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok)
        return {
          available: false,
          models: [],
          message: "未能获取该账户的模型列表，请手动填写模型 ID。",
        };
      const payload: unknown = await response.json();
      const candidates = Array.isArray(payload)
        ? payload
        : typeof payload === "object" && payload !== null && "data" in payload
          ? (payload as { data?: unknown }).data
          : null;
      const models = Array.from(
        new Set(
          (Array.isArray(candidates) ? candidates : [])
            .map((model) =>
              typeof model === "string"
                ? model
                : typeof model === "object" && model !== null && "id" in model
                  ? (model as { id?: unknown }).id
                  : null,
            )
            .filter((model): model is string => typeof model === "string")
            .map((model) => model.trim())
            .filter(Boolean),
        ),
      ).slice(0, 500);
      if (!models.length)
        return {
          available: false,
          models: [],
          message: "该账户未返回可用模型，请手动填写模型 ID。",
        };
      return { available: true, models };
    } catch {
      return {
        available: false,
        models: [],
        message: "无法获取该账户的模型列表，请手动填写模型 ID。",
      };
    }
  }
  private async account(db: Query, kind: ModelKind, id: number) {
    const row = (
      await db.query<AccountRow>(
        "SELECT * FROM model_accounts WHERE id=$1 AND kind=$2",
        [id, kind],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("账户不存在");
    return row;
  }
  private async assertUnused(db:Query,kind:ModelKind,field:'accountId'|'id',id:number) {
    const references=await this.references(kind,field==='accountId'?'accounts':'deployments',id,db);
    if(references.length)throw new ConflictException({message:'配置或历史发布仍依赖该资源，请先替换引用或归档',references});
  }
  async saveDeployment(
    actor: number,
    kind: ModelKind,
    id: number | null,
    body: unknown,
  ) {
    const fields = this.input(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          accountId: z.number().int().positive(),
          config: z.unknown(),
          enabled: z.boolean().optional(),
        })
        .strict(),
      body,
    );
    const config =
      kind === "llm"
        ? this.input(llmDeploymentSchema, fields.config)
        : this.input(embeddingDeploymentSchema, fields.config);
    return this.write(
      actor,
      id ? "model_deployment.updated" : "model_deployment.created",
      String(id ?? kind),
      async (c) => {
        const a = await this.account(c, kind, fields.accountId);
        if (!a.enabled || a.deleted_at || a.archived_at) throw new ConflictException("账户已停用或已移除");
        if (
          kind === "embedding" &&
          config.provider === "volcengine-multimodal" &&
          a.platform_key !== "volcengine"
        )
          throw new BadRequestException("火山多模态接口只适用于火山平台");
        if (id && fields.enabled === false)
          await this.assertUnused(c, kind, "id", id);
        const result = id
          ? await c.query(
              "UPDATE model_deployments SET name=$3,account_id=$4,config=$5,enabled=COALESCE($6,enabled),test_result=NULL,tested_at=NULL WHERE id=$1 AND kind=$2 AND deleted_at IS NULL AND archived_at IS NULL RETURNING id::int",
              [
                id,
                kind,
                fields.name,
                fields.accountId,
                JSON.stringify(config),
                fields.enabled ?? null,
              ],
            )
          : await c.query(
              "INSERT INTO model_deployments(kind,name,account_id,config,enabled) VALUES($1,$2,$3,$4,$5) RETURNING id::int",
              [
                kind,
                fields.name,
                fields.accountId,
                JSON.stringify(config),
                fields.enabled ?? true,
              ],
            );
        if (!result.rowCount) throw new NotFoundException("部署不存在");
        return result.rows[0];
      },
    );
  }
  private async snapshot(
    db: Query,
    kind: ModelKind,
    ids: number[],
  ): Promise<PlanConfig> {
    if (
      new Set(ids).size !== ids.length ||
      (kind === "embedding" && ids.length !== 1)
    )
      throw new BadRequestException(
        "部署不能重复；向量方案仅支持一个固定向量空间",
      );
    const deployments: DeploymentSnapshot[] = [];
    for (const id of ids) {
      const row = (
        await db.query(
          `SELECT d.id::int,d.name,d.config,d.account_id::int AS "accountId",a.base_url AS "baseUrl",d.enabled AND a.enabled AND d.deleted_at IS NULL AND d.archived_at IS NULL AND a.deleted_at IS NULL AND a.archived_at IS NULL AS enabled
    FROM model_deployments d JOIN model_accounts a ON a.id=d.account_id WHERE d.id=$1 AND d.kind=$2 AND a.kind=$2`,
          [id, kind],
        )
      ).rows[0];
      if (!row?.enabled) throw new ConflictException("部署或账户不可用");
      const { enabled, ...s } = row;
      deployments.push(s as DeploymentSnapshot);
    }
    return { deployments };
  }
  async createPlan(actor: number, kind: ModelKind, body: unknown) {
    const input = this.input(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          deploymentIds: selectionSchema.shape.deploymentIds,
        })
        .strict(),
      body,
    );
    return this.write(actor, "model_plan.created", kind, async (c) => {
      const config = await this.snapshot(c, kind, input.deploymentIds);
      const p = (
        await c.query(
          "INSERT INTO model_plans(kind,name) VALUES($1,$2) RETURNING id::int",
          [kind, input.name],
        )
      ).rows[0];
      return (
        await c.query(
          "INSERT INTO model_plan_versions(plan_id,version,config) VALUES($1,1,$2) RETURNING id::int",
          [p.id, JSON.stringify(config)],
        )
      ).rows[0];
    });
  }
  async version(db: Query, kind: ModelKind, id: number): Promise<PlanVersion> {
    const v = (
      await db.query<PlanVersion>(
        "SELECT v.*,v.id::int,v.plan_id::int,p.kind,p.name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND p.kind=$2",
        [id, kind],
      )
    ).rows[0];
    if (!v) throw new NotFoundException("方案版本不存在");
    return v;
  }
  async clone(actor: number, kind: ModelKind, id: number) {
    return this.write(actor, "model_plan.cloned", String(id), async (c) => {
      const source = await this.version(c, kind, id);
      const n = (
        await c.query(
          "SELECT COALESCE(MAX(version),0)+1 AS n FROM model_plan_versions WHERE plan_id=$1",
          [source.plan_id],
        )
      ).rows[0].n;
      return (
        await c.query(
          "INSERT INTO model_plan_versions(plan_id,version,config) VALUES($1,$2,$3) RETURNING id::int",
          [
            source.plan_id,
            n,
            JSON.stringify({ deployments: source.config.deployments }),
          ],
        )
      ).rows[0];
    });
  }
  async updateDraft(actor: number, kind: ModelKind, id: number, body: unknown) {
    const input = this.input(
      selectionSchema.extend({ revision: z.number().int().positive() }),
      body,
    );
    return this.write(
      actor,
      "model_plan.draft_updated",
      String(id),
      async (c) => {
        const v = await this.version(c, kind, id);
        if (v.status !== "draft" || v.revision !== input.revision)
          throw new ConflictException("版本已发布或草稿已变更，请刷新");
        const config = await this.snapshot(c, kind, input.deploymentIds);
        await c.query(
          "UPDATE model_plan_versions SET config=$2,revision=revision+1,test_signature=NULL,test_result=NULL,tested_at=NULL WHERE id=$1",
          [id, JSON.stringify(config)],
        );
        return { ok: true };
      },
    );
  }
  private async signature(db: Query, v: PlanVersion) {
    const revisions = [];
    for (const d of v.config.deployments) {
      const a = await this.account(db, v.kind, d.accountId);
      const deploy = (
        await db.query(
          "SELECT enabled AND deleted_at IS NULL AND archived_at IS NULL AS enabled FROM model_deployments WHERE id=$1 AND kind=$2",
          [d.id, v.kind],
        )
      ).rows[0];
      if (!a.enabled || !deploy?.enabled || a.base_url !== d.baseUrl)
        throw new ConflictException("方案依赖的账户或部署不可用");
      const credential = accountCredential(a, this.runtime);
      revisions.push([
        a.id,
        a.key_revision,
        createHash("sha256").update(credential).digest("hex"),
      ]);
    }
    return createHash("sha256")
      .update(JSON.stringify([v.config, revisions]))
      .digest("hex");
  }
  async testVersion(actor: number, kind: ModelKind, id: number) {
    const v = await this.version(this.database, kind, id);
    const signature = await this.signature(this.database, v);
    const results = [];
    for (const d of v.config.deployments)
      results.push(await this.probe(kind, d));
    const result = { ok: results.every((r) => r.ok), deployments: results };
    if (v.status === "draft")
      await this.write(actor, "model_plan.tested", String(id), async (c) => {
        const current = await this.version(c, kind, id);
        if (
          current.status !== "draft" ||
          current.revision !== v.revision ||
          signature !== (await this.signature(c, current))
        )
          throw new ConflictException("测试期间配置或密钥发生变化，请重新测试");
        await c.query(
          "UPDATE model_plan_versions SET test_signature=$2,test_result=$3,tested_at=now() WHERE id=$1",
          [id, signature, JSON.stringify(result)],
        );
      });
    return result;
  }
  async testDeployment(actor: number, kind: ModelKind, id: number) {
    const s = await this.snapshot(this.database, kind, [id]);
    const keyRevision=(await this.account(this.database,kind,s.deployments[0]!.accountId)).key_revision;
    const result = await this.probe(kind, s.deployments[0]!);
    await this.write(
      actor,
      "model_deployment.tested",
      String(id),
      async c => {
        const current=await this.snapshot(c,kind,[id]);
        if(JSON.stringify(current.deployments[0])!==JSON.stringify(s.deployments[0]) || keyRevision!==(await this.account(c,kind,s.deployments[0]!.accountId)).key_revision)throw new ConflictException('测试期间部署或凭据发生变化，请重新测试');
        await c.query('UPDATE model_deployments SET test_result=$2,tested_at=now() WHERE id=$1',[id,JSON.stringify(result)]);
      },
    );
    return result;
  }
  private async probe(
    kind: ModelKind,
    d: DeploymentSnapshot,
  ) {
    const start = Date.now();
    let message = "连接和协议验证通过";
    let ok = true;
    let stage = "credential";
    const checks: { stage: string; ok: boolean; message: string; durationMs: number }[] = [];
    let checkStart = start;
    const begin = (name: string) => { stage = name; checkStart = Date.now(); };
    const passed = () => checks.push({ stage, ok: true, message: "验证通过", durationMs: Date.now() - checkStart });
    let details: { code?: string; status?: number; providerCode?: string; providerMessage?: string } = {};
    try {
      const a = await this.account(this.database, kind, d.accountId);
      const apiKey = accountCredential(a, this.runtime);
      if (kind === "embedding") {
        begin("embedding");
        const profile = embeddingProfileSchema.parse({
          ...d.config,
          baseUrl: d.baseUrl,
        });
        await embedWithProfile(profile, ["连接测试"], this.runtime, { apiKey });
        passed();
      } else {
        const config = llmDeploymentSchema.parse(d.config);
        const provider = new LangChainOpenAIProvider({
          ...config,
          baseUrl: d.baseUrl,
          apiKey,
        });
        const responseFormat = {
          type: "json_schema" as const,
          json_schema: {
            name: "connection_probe",
            strict: true,
            schema: {
              type: "object",
              properties: { message: { type: "string", enum: ["连接成功"] } },
              required: ["message"],
              additionalProperties: false,
            },
          },
        };
        begin("structured");
        const response = await provider.chat({
          model: config.model,
          messages: [
            {
              role: "user",
              content: '仅返回 JSON 对象 {"message":"连接成功"}',
            },
          ],
          responseFormat,
          maxTokens: config.maxOutputTokens,
        });
        if (response.finishReason === "length")
          throw new Error(`输出达到 ${config.maxOutputTokens} Token 上限，请提高部署的输出 Token 上限后重试`);
        let structured: unknown;
        try { structured = JSON.parse(response.content); }
        catch { throw new Error("未返回有效 JSON，请检查模型的结构化输出能力及输出 Token 上限"); }
        if (
          response.toolCalls?.length ||
          !z
            .object({ message: z.literal("连接成功") })
            .strict()
            .safeParse(structured).success
        )
          throw new Error("结构化输出不符合测试约定，需要返回 message 字段且值为连接成功");
        passed();
        begin("tools");
        const probe = await provider.chat({
          model: config.model,
          messages: [
            {
              role: "user",
              content:
                '调用 connection_probe，参数 {"probe":"connection-test"}',
            },
          ],
          tools: [
            {
              name: "connection_probe",
              description: "连接能力测试",
              parameters: {
                type: "object",
                properties: {
                  probe: { type: "string", enum: ["connection-test"] },
                },
                required: ["probe"],
                additionalProperties: false,
              },
            },
          ],
          toolChoice: { name: "connection_probe" },
          maxTokens: config.maxOutputTokens,
        });
        const call = probe.toolCalls?.[0];
        if (
          probe.toolCalls?.length !== 1 ||
          !call?.id ||
          call.name !== "connection_probe" ||
          !z
            .object({ probe: z.literal("connection-test") })
            .strict()
            .safeParse(call.arguments).success
        )
          throw new Error("未返回有效的原生 Tool Call，请检查模型工具调用能力及输出 Token 上限");
        passed();
        begin("stream");
        // Answer generation also needs native streaming, not just non-stream chat.
        let finishReason: string | null = null,
          text = "";
        for await (const event of provider.stream({
          model: config.model,
          messages: [{ role: "user", content: "回复连接成功" }],
          maxTokens: config.maxOutputTokens,
        })) {
          if (event.type === "text_delta") text += event.delta;
          if (event.type === "completed")
            finishReason = event.finishReason;
        }
        if (finishReason === "length")
          throw new Error(`流式输出达到 ${config.maxOutputTokens} Token 上限（包含模型思考 Token），请提高部署的输出 Token 上限后重试`);
        if (finishReason !== "stop" || !text.trim())
          throw new Error(`流式响应没有正常输出正文（完成原因：${finishReason ?? "未返回"}）`);
        passed();
      }
    } catch (error) {
      ok = false;
      if (error instanceof ProviderError || error instanceof EmbeddingRequestError) {
        details = { code: error.code, status: error.status,
          providerCode: error.diagnostics?.code, providerMessage: error.diagnostics?.message };
        const hints: Record<string, string> = {
          provider_authentication: "密钥无效或未获授权，请检查供应商凭据与模型权限",
          provider_timeout: "供应商请求超时，请检查网络或提高部署超时时间",
          provider_rate_limit: "供应商请求限流，请稍后重试",
          provider_quota_exhausted: "供应商额度或余额不足",
          provider_model_not_found: "模型不存在或未开通，请检查模型 ID 与账户权限",
          provider_unsupported_response_format: "模型不支持所需的结构化输出格式",
          provider_invalid_request: "供应商拒绝请求参数",
          provider_invalid_response: "供应商返回的响应格式无效",
          model_output_truncated: "模型输出达到 Token 上限（包含思考 Token），请提高部署的输出 Token 上限后重试",
          model_content_filtered: "供应商过滤了本次模型输出，请调整测试内容或模型配置",
          provider_unavailable: "供应商连接或服务不可用",
          provider_connection: "无法连接向量模型服务",
          embedding_http_error: "向量模型服务拒绝请求",
        };
        message = hints[error.code] ?? "模型调用失败";
      } else if (error instanceof EmbeddingDimensionError) {
        details.code = "embedding_dimension_mismatch";
        message = `维度不匹配：配置 ${error.expectedDimensions}，实际 ${error.actualDimensions}`;
      } else if (error instanceof z.ZodError) {
        details.code = "invalid_response_or_config";
        message = "模型配置或向量响应格式不符合约定，请检查协议、向量数量与维度";
      } else {
        // Only these known local errors may be exposed. Unknown errors remain private.
        const known = ["输出达到", "未返回有效", "结构化输出不符合", "流式输出达到", "流式响应没有",
          "Model account credential", "Model requires a credential", "Embedding credential", "Embedding endpoint", "Invalid embedding"];
        message = error instanceof Error && known.some(prefix => error.message.startsWith(prefix))
          ? error.message : "模型验证失败，请检查凭据配置与协议能力";
        details.code = "model_validation_failed";
      }
      checks.push({ stage, ok: false, message, durationMs: Date.now() - checkStart });
    }
    return { id: d.id, name: d.name, model: d.config.model, ok, message, stage, checks, ...details, durationMs: Date.now() - start };
  }

  async publish(actor: number, kind: ModelKind, id: number, expectedRevision?:number) {
    return this.write(actor, "model_plan.published", String(id), async (c) => {
      const v = await this.version(c, kind, id);
      if (v.status !== "draft") throw new ConflictException("该版本已经发布");
      if(!(await c.query('SELECT id FROM model_plans WHERE id=$1 AND deleted_at IS NULL AND archived_at IS NULL',[v.plan_id])).rowCount)
        throw new ConflictException('方案已移除，不能发布');
      if(expectedRevision!==undefined&&v.revision!==expectedRevision)throw new ConflictException('测试期间配置发生变化，请重新测试并发布');
      if (
        !(v.test_result as { ok?: boolean })?.ok ||
        v.test_signature !== (await this.signature(c, v))
      )
        throw new ConflictException("请先对当前配置和密钥完成测试");
      if (kind === "embedding") {
        const d = v.config.deployments[0]!;
        const a = await this.account(c, kind, d.accountId);
        const config = embeddingProfileSchema.parse({
          ...d.config,
          baseUrl: d.baseUrl,
        });
        // Imported drafts may already have a profile referenced by a knowledge base.
        // Keep its identity, but never overwrite a different vector space or account.
        const existing = (
          await c.query<{ id: number; config: unknown; model_account_id: number | null }>(
            "SELECT id::int,config,model_account_id::int FROM embedding_profiles WHERE model_plan_version_id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (existing) {
          const previous = embeddingProfileSchema.safeParse(existing.config);
          if (
            !previous.success ||
            existing.model_account_id !== d.accountId ||
            embeddingFingerprint(previous.data) !== embeddingFingerprint(config)
          )
            throw new ConflictException(
              "该版本已有不同的向量配置，请新建草稿版本后发布，以保留知识库原有的向量空间和账户关联",
            );
        }
        const e = existing ?? (
          await c.query(
            "INSERT INTO embedding_profiles(name,platform_key,config,model_account_id,model_plan_version_id) VALUES($1,$2,$3,$4,$5) RETURNING id::int",
            [
              `${v.name} · v${v.version}`,
              a.platform_key,
              JSON.stringify(config),
              a.id,
              id,
            ],
          )
        ).rows[0];
        await c.query("UPDATE embedding_profiles SET config=$2,name=$3,platform_key=$4,enabled=true,updated_at=now() WHERE id=$1", [
          e.id,
          JSON.stringify({
            ...config,
            profileId: e.id,
            fingerprint: embeddingFingerprint(config),
          }),
          `${v.name} · v${v.version}`,
          a.platform_key,
        ]);
      }
      await c.query(
        "UPDATE model_plan_versions SET status='published',published_at=now() WHERE id=$1",
        [id],
      );
      await c.query('UPDATE model_plans SET current_version_id=$2 WHERE id=$1',[v.plan_id,id]);
      if(kind==='llm')await c.query(`UPDATE model_bindings b SET version_id=$2,updated_at=now() FROM model_plan_versions old
        WHERE old.id=b.version_id AND old.plan_id=$1`,[v.plan_id,id]);
      return { ok: true };
    });
  }
  async activate(actor: number, kind: ModelKind, id: number) {
    if (kind !== "llm")
      throw new BadRequestException(
        "向量版本需要在知识库中选择、构建并应用索引",
      );
    const result = await this.write(
      actor,
      "model_plan.activated",
      String(id),
      async (c) => {
        const v = await this.version(c, kind, id);
        if (v.status !== "published")
          throw new ConflictException("只能使用已发布的版本");
        await this.signature(c, v);
        await c.query(
          "INSERT INTO model_bindings(purpose,version_id) VALUES('default',$1) ON CONFLICT(workspace_id,purpose) DO UPDATE SET version_id=EXCLUDED.version_id,updated_at=now()",
          [id],
        );
        return { ok: true };
      },
    );
    await this.activePlan();
    return result;
  }
  async activePlan(): Promise<PlanVersion | null> {
    const row = (
      await this.database.query<{ version_id: number }>(
        "SELECT version_id::int FROM model_bindings WHERE purpose='default'",
      )
    ).rows[0];
    const plan = row
      ? await this.version(this.database, "llm", row.version_id)
      : null;
    this.workspacePlans.set(currentWorkspaceId(),plan);
    return plan;
  }
  async credential(d: DeploymentSnapshot) {
    const a = await this.account(this.database, "llm", d.accountId);
    if (a.base_url !== d.baseUrl)
      throw new Error("Account endpoint identity changed");
    return accountCredential(a, this.runtime);
  }
}
