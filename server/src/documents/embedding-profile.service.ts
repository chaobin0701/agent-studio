import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { AppConfigService } from '../config/config.service';
import { EmbeddingDimensionError, embeddingFingerprint, embeddingProfileSchema, embedWithProfile, validateManagedEndpoint, validateProfileEndpoint, type EmbeddingProfile } from './profile-embedding';
import { SecretBox } from '../security/secret-box';
import { resolveEmbeddingCredential } from './embedding-runtime';

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platformKey: z.enum(['volcengine','openai','custom']),
  provider: embeddingProfileSchema.shape.provider,
  baseUrl: embeddingProfileSchema.shape.baseUrl,
  model: embeddingProfileSchema.shape.model,
  dimensions: embeddingProfileSchema.shape.dimensions,
  maxInputChars: embeddingProfileSchema.shape.maxInputChars.removeDefault(),
  batchSize: embeddingProfileSchema.shape.batchSize.removeDefault(),
  timeoutMs: embeddingProfileSchema.shape.timeoutMs.removeDefault(),
  apiKey: z.string().trim().min(1).max(500).optional(),
}).strict();
const updateSchema = inputSchema.partial();
type Row = { id: number; name: string; platform_key: 'volcengine'|'openai'|'custom'; config: unknown; api_key_ciphertext: string|null; enabled: boolean; created_at?: string; updated_at?: string };
type Usage = { id: number; name: string; archived: boolean; configured: boolean; active: boolean; historical: boolean };
export const EMBEDDING_PLATFORMS = [
  { key:'volcengine',label:'火山引擎方舟',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',provider:'volcengine-multimodal',model:'doubao-embedding-vision-251215',dimensions:2048 },
  { key:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1',provider:'openai-compatible',model:'',dimensions:1536 },
  { key:'custom',label:'其他兼容平台',baseUrl:'',provider:'openai-compatible',model:'',dimensions:2048 },
] as const;

@Injectable()
export class EmbeddingProfileService {
  constructor(private readonly database: DatabaseService, private readonly runtime: AppConfigService, private readonly secrets: SecretBox) {}

  async list() {
    const rows = (await this.database.query<Row>('SELECT id::int,name,platform_key,config,api_key_ciphertext,enabled,created_at,updated_at FROM embedding_profiles ORDER BY enabled DESC,updated_at DESC,id DESC')).rows;
    return Promise.all(rows.map(async row => this.view(row, await this.references(row.id))));
  }

  metadata() { return { platforms: EMBEDDING_PLATFORMS, minDimensions:1,maxDimensions:4096 }; }

  async choices(publishedOnly = false) {
    const sql = publishedOnly
      ? `SELECT e.id::int,e.name,e.config,e.enabled FROM embedding_profiles e
          JOIN model_plan_versions v ON v.id=e.model_plan_version_id AND v.status='published'
          JOIN model_plans p ON p.id=v.plan_id AND p.kind='embedding' AND p.deleted_at IS NULL AND p.archived_at IS NULL
          WHERE e.enabled ORDER BY e.name,e.id`
      : 'SELECT id::int,name,config,enabled FROM embedding_profiles WHERE enabled ORDER BY name,id';
    return (await this.database.query<Row>(sql)).rows
      .map(row => { const config=embeddingProfileSchema.parse(row.config); return { id:row.id,name:row.name,enabled:row.enabled,config:{model:config.model,dimensions:config.dimensions,provider:config.provider} }; });
  }

  async create(actorId: number, input: unknown) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid embedding profile');
    const { name,platformKey,apiKey,...fields }=parsed.data;
    const config=embeddingProfileSchema.parse(fields);
    this.validatePlatform(platformKey,config);
    if (!apiKey) throw new BadRequestException('新配置需要填写 API Key，密钥不会从其他配置复制');
    return this.database.transaction(async (client) => {
      const row = (await client.query<Row>('INSERT INTO embedding_profiles(name,platform_key,config,api_key_ciphertext) VALUES ($1,$2,$3,$4) RETURNING id::int,name,platform_key,config,api_key_ciphertext,enabled',
        [name,platformKey,JSON.stringify(config),this.secrets.encrypt(apiKey)])).rows[0]!;
      const frozen={...config,profileId:row.id,fingerprint:embeddingFingerprint(config)};
      await client.query('UPDATE embedding_profiles SET config=$2 WHERE id=$1',[row.id,JSON.stringify(frozen)]);
      row.config=frozen;
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id)
        VALUES ($1,'embedding_profile.created','embedding_profile',$2)`, [actorId, String(row.id)]);
      return this.view(row,[]);
    });
  }

  async update(actorId:number,id:number,input:unknown) {
    const parsed=updateSchema.safeParse(input);
    if(!parsed.success || !Object.keys(parsed.data).length) throw new BadRequestException('No valid embedding configuration fields');
    return this.database.transaction(async client=>{
      const row=await this.find(id,client,true);
      const references=await this.references(id,client);
      const current=embeddingProfileSchema.parse(row.config);
      if(parsed.data.platformKey!==undefined && parsed.data.platformKey!==row.platform_key) throw new BadRequestException('平台创建后不可修改，请新建替代配置');
      const {name,platformKey:_platform,apiKey,...changes}=parsed.data;
      const config=embeddingProfileSchema.parse({...current,...changes});
      this.validatePlatform(row.platform_key,config);
      if(references.length && embeddingFingerprint(config)!==embeddingFingerprint(current)) throw new ConflictException('配置已被知识库或索引引用，模型、接口和维度不可原地修改，请新建配置并重建索引');
      const frozen={...config,profileId:id,fingerprint:embeddingFingerprint(config)};
      const result=(await client.query<Row>(`UPDATE embedding_profiles SET name=$2,config=$3,api_key_ciphertext=$4,updated_at=now()
        WHERE id=$1 RETURNING id::int,name,platform_key,config,api_key_ciphertext,enabled`,[id,name??row.name,JSON.stringify(frozen),apiKey?this.secrets.encrypt(apiKey):row.api_key_ciphertext])).rows[0]!;
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
        VALUES($1,'embedding_profile.updated','embedding_profile',$2,$3)`,[actorId,String(id),JSON.stringify({fields:Object.keys(parsed.data).filter(key=>key!=='apiKey'),keyChanged:Boolean(apiKey)})]);
      return this.view(result,references);
    });
  }

  async setEnabled(actorId: number, id: number, input: unknown) {
    const parsed=z.object({enabled:z.boolean()}).strict().safeParse(input);
    if(!parsed.success) throw new BadRequestException('enabled must be a boolean');
    return this.database.transaction(async(client)=>{
      await this.find(id,client,true);
      const usage=await this.references(id,client);
      if(!parsed.data.enabled && usage.some(item=>!item.archived && (item.configured||item.active))) throw new ConflictException('配置仍被知识库使用，请先为相关知识库替换模型并应用新索引');
      const row=(await client.query<Row>('UPDATE embedding_profiles SET enabled=$2,updated_at=now() WHERE id=$1 RETURNING id::int,name,platform_key,config,api_key_ciphertext,enabled',[id,parsed.data.enabled])).rows[0]!;
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
        VALUES($1,'embedding_profile.updated','embedding_profile',$2,$3)`,[actorId,String(id),JSON.stringify(parsed.data)]);
      return this.view(row,usage);
    });
  }

  async remove(actorId:number,id:number) {
    return this.database.transaction(async client=>{
      await this.find(id,client,true);
      if((await this.references(id,client)).length) throw new ConflictException('配置被知识库、文档向量或历史索引引用，不能删除');
      await client.query('DELETE FROM embedding_profiles WHERE id=$1',[id]);
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id) VALUES($1,'embedding_profile.deleted','embedding_profile',$2)`,[actorId,String(id)]);
      return {deleted:true};
    });
  }

  async usage(id:number) { await this.find(id); return this.references(id); }

  async test(actorId:number,input:unknown) {
    const parsed=inputSchema.extend({profileId:z.number().int().positive().optional()}).safeParse(input);
    if(!parsed.success) throw new BadRequestException('Invalid embedding connection test');
    const {name:_name,platformKey,apiKey,profileId,...fields}=parsed.data;
    const profile=embeddingProfileSchema.parse(fields);
    this.validatePlatform(platformKey,profile);
    const started=performance.now();
    let saved:EmbeddingProfile|undefined;
    if(!apiKey && profileId) {
      const existing=await this.find(profileId);
      saved=embeddingProfileSchema.parse(existing.config);
      if(existing.platform_key!==platformKey || saved.baseUrl.replace(/\/+$/,'')!==profile.baseUrl.replace(/\/+$/,'') || saved.provider!==profile.provider) throw new BadRequestException('不能借用其他平台或地址的已有密钥');
    } else if(!apiKey) throw new BadRequestException('API Key is required');
    let result:Record<string,unknown>;
    try {
      const credential=apiKey?{apiKey}:await resolveEmbeddingCredential(this.database,this.runtime,saved!);
      const [vector]=await embedWithProfile(profile,['这是一段用于验证向量模型连接的测试文本。'],this.runtime,credential);
      result={ok:true,model:profile.model,expectedDimensions:profile.dimensions,actualDimensions:vector!.length,dimensionMatched:true,durationMs:Math.round(performance.now()-started),message:'连接成功，返回维度与配置一致。'};
    } catch(error) {
      const dimension=error instanceof EmbeddingDimensionError;
      const message=dimension?'返回维度与配置不一致，请核对模型和维度。':error instanceof Error && /HTTP 40[13]/u.test(error.message)?'密钥无效或没有模型访问权限。':error instanceof Error && /HTTP 429/u.test(error.message)?'服务限流或额度不足，请稍后重试。':'连接失败，请核对地址、模型和密钥；服务可能超时或返回无效数据。';
      result={ok:false,model:profile.model,expectedDimensions:profile.dimensions,...(dimension?{actualDimensions:error.actualDimensions,dimensionMatched:false}:{}),durationMs:Math.round(performance.now()-started),message};
    }
    await this.database.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'embedding_profile.tested','embedding_profile',$2,$3)`,[actorId,profileId?String(profileId):'unsaved',JSON.stringify({ok:result.ok,model:profile.model})]);
    return result;
  }

  private async find(id:number,database:Pick<DatabaseService,'query'>=this.database,lock=false):Promise<Row> {
    const row=(await database.query<Row>(`SELECT id::int,name,platform_key,config,api_key_ciphertext,enabled FROM embedding_profiles WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
    if(!row) throw new NotFoundException('Embedding profile not found');
    return row;
  }

  private async references(id:number,database:Pick<DatabaseService,'query'>=this.database):Promise<Usage[]> {
    return (await database.query<Usage>(`SELECT kb.id::int,kb.name,kb.archived_at IS NOT NULL AS archived,
      (kb.draft_config->>'embeddingProfileId')::bigint=$1 AS configured,
      EXISTS(SELECT 1 FROM knowledge_index_versions v WHERE v.id=kb.active_index_version_id AND ((v.embedding_snapshot->>'profileId')::bigint=$1 OR (v.config->>'embeddingProfileId')::bigint=$1)) AS active,
      EXISTS(SELECT 1 FROM knowledge_index_versions v WHERE v.knowledge_base_id=kb.id AND ((v.embedding_snapshot->>'profileId')::bigint=$1 OR (v.config->>'embeddingProfileId')::bigint=$1)) AS historical
      FROM knowledge_bases kb WHERE (kb.draft_config->>'embeddingProfileId')::bigint=$1
        OR EXISTS(SELECT 1 FROM knowledge_index_versions v WHERE v.knowledge_base_id=kb.id AND ((v.embedding_snapshot->>'profileId')::bigint=$1 OR (v.config->>'embeddingProfileId')::bigint=$1))
        OR EXISTS(SELECT 1 FROM documents d JOIN document_chunks c ON c.document_id=d.id WHERE d.knowledge_base_id=kb.id AND c.embedding_profile_id=$1)
      ORDER BY kb.archived_at NULLS FIRST,kb.id`,[id])).rows;
  }

  private validatePlatform(key:'volcengine'|'openai'|'custom',profile:EmbeddingProfile) {
    try { validateManagedEndpoint(profile,this.runtime); } catch(error) { throw new BadRequestException((error as Error).message); }
    if(key==='openai' && profile.provider!=='openai-compatible') throw new BadRequestException('OpenAI 平台使用标准 Embeddings 接口');
    if(key!=='volcengine' && profile.provider==='volcengine-multimodal') throw new BadRequestException('火山多模态接口只适用于火山平台');
  }

  private view(row:Row,usage:Usage[]) {
    const config=embeddingProfileSchema.parse(row.config);
    let key='';
    if(row.api_key_ciphertext) key=this.secrets.decrypt(row.api_key_ciphertext);
    else {
      try { validateProfileEndpoint(config,this.runtime); key=(config.secretRef==='default'?this.runtime.embedding:this.runtime.embedding.connections?.[config.secretRef])?.apiKey??''; } catch { /* never borrow a key from a different endpoint */ }
    }
    const usageCount=usage.filter(item=>!item.archived&&(item.configured||item.active)).length;
    return {id:row.id,name:row.name,platformKey:row.platform_key,config,enabled:row.enabled,hasApiKey:Boolean(key),apiKeyPreview:key?(key.length>=8?`${key.slice(0,2)}***${key.slice(-2)}`:'********'):null,keySource:row.api_key_ciphertext?'managed':'environment',usageCount,referenceCount:usage.length,geometryLocked:usage.length>0,createdAt:row.created_at,updatedAt:row.updated_at};
  }
}
