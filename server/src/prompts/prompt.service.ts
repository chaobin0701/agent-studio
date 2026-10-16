import { effectiveAgentVersion } from '../agent-management/effective-agent-version';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { environmentSchema, promptTypeSchema } from "./prompt.types";
import {
  extractVariables,
  renderPrompt,
  validatePromptTemplate,
} from "./prompt-renderer";

export const PLATFORM_PROMPT_KEYS = ["agent.planner", "agent.answer"] as const;
const isPlatform = (key: string) =>
  (PLATFORM_PROMPT_KEYS as readonly string[]).includes(key);
const resourceInput = z
  .object({
    promptKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9._-]{2,159}$/)
      .optional(),
    name: z.string().trim().min(1).max(160),
    promptType: promptTypeSchema.exclude(["summary"]).default("system"),
    description: z.string().max(2000).default(""),
    template: z.string().max(100000).default(""),
  })
  .strict();
const variablesSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/),
  z
    .object({
      type: z.enum(["string", "number", "boolean", "object", "array"]),
      required: z.boolean(),
      description: z.string().max(500).optional(),
    })
    .strict(),
);
const contentInput = z
  .object({
    template: z.string().min(1).max(100000),
    variables: variablesSchema,
    changeNote: z.string().max(1000).default(""),
  })
  .strict();
const updateInput = contentInput.extend({
  expectedRevision: z.number().int().positive().optional(),
});
const reviewInput = contentInput
  .omit({ changeNote: true })
  .extend({ expectedRevision: z.number().int().positive() });
const publishInput = updateInput.extend({
  expectedRevision: z.number().int().positive(),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  changeNote: z.string().trim().min(1).max(1000),
});
const allowed =
  "r.prompt_type <> 'summary' AND r.prompt_key <> 'conversation.summary'";
type Query = Pick<DatabaseService, "query">;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
@Injectable()
export class PromptService {
  constructor(private readonly db: DatabaseService) {}
  async list(): Promise<unknown[]> {
    return (
      await this.db.query(
        `SELECT r.id::int,r.prompt_key AS "promptKey",r.name,r.prompt_type AS "promptType",r.description,r.updated_at AS "updatedAt",false AS "isPlatform",count(v.id)::int AS "versionCount",max(v.version)::int AS "latestVersion",max(v.version) FILTER(WHERE v.status='published')::int AS "publishedVersion",max(v.version) FILTER(WHERE v.status='draft')::int AS "draftVersion" FROM prompt_resources r LEFT JOIN prompt_versions v ON v.resource_id=r.id WHERE ${allowed} AND r.archived_at IS NULL AND r.prompt_key NOT IN ('agent.planner','agent.answer') GROUP BY r.id ORDER BY r.updated_at DESC`,
      )
    ).rows;
  }
  async get(id: number): Promise<any> {
    const r = await this.resource(this.db, id);
    const versions = (
      await this.db.query(
        `SELECT v.id::int AS "versionId",v.resource_id::int AS "resourceId",v.version,v.status,v.revision,v.source_version_id::int AS "sourceVersionId",v.template,v.variables,v.change_note AS "changeNote",v.created_at AS "createdAt",v.published_at AS "publishedAt",a.display_name AS "publishedBy",coalesce(array_agg(b.environment) FILTER(WHERE b.environment IS NOT NULL),'{}') AS environments FROM prompt_versions v LEFT JOIN prompt_environment_bindings b ON b.version_id=v.id LEFT JOIN admins a ON a.id=v.published_by WHERE v.resource_id=$1 GROUP BY v.id,a.display_name ORDER BY v.version DESC`,
        [id],
      )
    ).rows;
    return { ...r, isPlatform: isPlatform(r.promptKey), versions };
  }
  async create(actor: number, body: unknown) {
    const input = this.parse(resourceInput, body),
      key = input.promptKey ?? `prompt.${randomUUID().replaceAll("-", "")}`;
    if (key === "conversation.summary" || isPlatform(key))
      throw new BadRequestException("此 Key 为系统内部保留，不支持业务配置");
    return this.db.transaction(async (c) => {
      const r = (
        await c.query<any>(
          "INSERT INTO prompt_resources(prompt_key,name,prompt_type,description,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,prompt_key) DO NOTHING RETURNING id::int",
          [key, input.name, input.promptType, input.description, actor],
        )
      ).rows[0];
      if (!r) throw new ConflictException("Prompt Key 已存在");
      await c.query(
        "INSERT INTO prompt_versions(resource_id,version,template,variables,created_by,change_note) VALUES($1,1,$2,'{}',$3,'首次发布')",
        [r.id, input.template, actor],
      );
      await this.audit(c, actor, "prompt.created", r.id, { promptKey: key });
      return r;
    });
  }
  async createVersion(actor: number, resourceId: number, body: unknown) {
    const input = this.parse(contentInput, body);
    return this.db.transaction(async (c) => {
      await this.resource(c, resourceId, true);
      const previous = (
        await c.query<any>(
          "SELECT id::int FROM prompt_versions WHERE resource_id=$1 AND status='published' ORDER BY version DESC LIMIT 1",
          [resourceId],
        )
      ).rows[0];
      return this.insertDraft(
        c,
        actor,
        resourceId,
        input,
        previous?.id ?? null,
      );
    });
  }
  async updateDraft(actor: number, versionId: number, body: unknown) {
    const input = this.parse(updateInput, body);
    return this.db.transaction(async (c) => {
      const v = await this.version(c, versionId, true);
      this.assertDraft(v, input.expectedRevision);
      await c.query(
        "UPDATE prompt_versions SET template=$2,variables=$3,change_note=$4,revision=revision+1 WHERE id=$1",
        [
          versionId,
          input.template,
          JSON.stringify(input.variables),
          input.changeNote,
        ],
      );
      await c.query(
        "UPDATE prompt_resources SET updated_at=now() WHERE id=$1",
        [v.resource_id],
      );
      await this.audit(c, actor, "prompt.version_updated", versionId, {
        resourceId: v.resource_id,
        revision: v.revision + 1,
      });
      return { ok: true, revision: v.revision + 1 };
    });
  }
  async clone(actor: number, versionId: number) {
    const v = await this.version(this.db, versionId);
    return this.db.transaction(async (c) => {
      await this.resource(c, v.resource_id, true);
      return this.insertDraft(
        c,
        actor,
        v.resource_id,
        {
          template: v.template,
          variables: v.variables,
          changeNote: `基于 v${v.version} 创建`,
        },
        v.id,
      );
    });
  }
  async prepareDraft(actor: number, versionId: number) {
    const anchor = await this.version(this.db, versionId);
    return this.db.transaction(async (c) => {
      await this.resource(c, anchor.resource_id, true);
      const existing = (
        await c.query<any>(
          "SELECT id::int AS \"versionId\",version FROM prompt_versions WHERE resource_id=$1 AND status='draft' ORDER BY version DESC LIMIT 1",
          [anchor.resource_id],
        )
      ).rows[0];
      if (existing) return { ...existing, reused: true };
      const source = await this.version(c, versionId);
      return {
        ...(await this.insertDraft(
          c,
          actor,
          source.resource_id,
          {
            template: source.template,
            variables: source.variables,
            changeNote: "",
          },
          source.id,
        )),
        reused: false,
      };
    });
  }
  private async insertDraft(
    c: Query,
    actor: number,
    resourceId: number,
    input: z.infer<typeof contentInput>,
    source: number | null,
  ) {
    const n = Number(
      (
        await c.query<any>(
          "SELECT coalesce(max(version),0)+1 n FROM prompt_versions WHERE resource_id=$1",
          [resourceId],
        )
      ).rows[0].n,
    );
    const r = (
      await c.query<any>(
        'INSERT INTO prompt_versions(resource_id,version,template,variables,change_note,created_by,source_version_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::int AS "versionId",version,status',
        [
          resourceId,
          n,
          input.template,
          JSON.stringify(input.variables),
          input.changeNote,
          actor,
          source,
        ],
      )
    ).rows[0];
    await c.query("UPDATE prompt_resources SET updated_at=now() WHERE id=$1", [
      resourceId,
    ]);
    await this.audit(c, actor, "prompt.version_created", r.versionId, {
      resourceId,
      version: n,
      sourceVersionId: source,
    });
    return r;
  }
  async preview(resourceId: number, body: unknown) {
    await this.resource(this.db, resourceId);
    const input = this.parse(
      contentInput
        .omit({ changeNote: true })
        .extend({ values: z.record(z.string(), z.unknown()).default({}) }),
      body,
    );
    return {
      text: renderPrompt(input.template, input.variables, input.values),
      variables: extractVariables(input.template),
      inputHash: hash(input.values),
      saved: false,
    };
  }
  async render(resourceId: number, versionId: number, body: unknown) {
    const v = await this.version(this.db, versionId);
    if (Number(v.resource_id) !== resourceId)
      throw new NotFoundException("Prompt 版本不存在");
    const input = this.parse(z.record(z.string(), z.unknown()), body);
    return {
      version: v.version,
      text: renderPrompt(v.template, v.variables, input),
      variables: extractVariables(v.template),
      inputHash: hash(input),
    };
  }
  async diff(left: number, right: number) {
    const a = await this.version(this.db, left),
      b = await this.version(this.db, right);
    if (a.resource_id !== b.resource_id)
      throw new BadRequestException("只能比较同一 Prompt 资源的版本");
    return { left: this.diffView(a), right: this.diffView(b) };
  }
  private diffView(v: any) {
    return {
      versionId: v.id,
      version: v.version,
      status: v.status,
      template: v.template,
      variables: v.variables,
    };
  }
  async review(versionId: number, body: unknown) {
    this.assertBusiness((await this.version(this.db, versionId)).promptKey);
    const input = this.parse(reviewInput, body),
      v = await this.version(this.db, versionId);
    this.assertDraft(v, input.expectedRevision);
    validatePromptTemplate(input.template, input.variables);
    const source = (
      await this.db.query<any>(
        `SELECT v.*,v.id::int AS id FROM prompt_versions v WHERE resource_id=$1 AND status='published' AND (id=$2 OR $2::bigint IS NULL AND version<$3) ORDER BY version DESC LIMIT 1`,
        [v.resource_id, v.source_version_id, v.version],
      )
    ).rows[0];
    const r = await this.resource(this.db, v.resource_id);
    return {
      reviewHash: this.reviewHash(v, input),
      source: source
        ? this.diffView(source)
        : { version: null, template: "", variables: {} },
      target: {
        ...this.diffView(v),
        template: input.template,
        variables: input.variables,
      },
      isPlatform: isPlatform(r.promptKey),
      agentSelectable:
        !r.archivedAt && !isPlatform(r.promptKey) &&
        !extractVariables(input.template).length &&
        !Object.values(input.variables).some((d) => d.required) &&
        input.template.length <= 24000,
      usage: await this.usage(v.resource_id),
      suggestedNote: source ? "" : "首次发布",
    };
  }
  private reviewHash(
    v: any,
    input: Pick<z.infer<typeof reviewInput>, "template" | "variables">,
  ) {
    return hash([v.id, v.revision, input.template, input.variables]);
  }
  async usage(resourceId: number) {
    await this.resource(this.db, resourceId);
    return (
      await this.db.query(
        `SELECT r.id::int AS "agentId",r.name,r.enabled,v.id::int AS "agentVersionId",v.version,v.status,${effectiveAgentVersion('r','v')} AS \"isCurrent\",'[]'::jsonb AS environments FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id WHERE r.kind='agent' AND (v.config->>'promptVersionId')::bigint IN (SELECT id FROM prompt_versions WHERE resource_id=$1) ORDER BY r.id,v.version DESC`,
        [resourceId],
      )
    ).rows;
  }
  async publish(actor: number, versionId: number, body?: unknown) {
    const input =
      body === undefined ? undefined : this.parse(publishInput, body);
    return this.db.transaction(async (c) => {
      const v = await this.version(c, versionId, true);
      this.assertDraft(v, input?.expectedRevision);
      if (input && this.reviewHash(v, input) !== input.reviewHash)
        throw new ConflictException("审阅内容发生变化，请重新查看差异后发布");
      const template = input?.template ?? v.template,
        variables = input?.variables ?? v.variables;
      validatePromptTemplate(template, variables);
      const note = input?.changeNote ?? (v.change_note.trim() || "首次发布");
      await c.query(
        "UPDATE prompt_versions SET template=$2,variables=$3,change_note=$4,status='published',published_at=now(),published_by=$5,revision=revision+1 WHERE id=$1",
        [versionId, template, JSON.stringify(variables), note, actor],
      );
      await c.query(
        "UPDATE prompt_resources SET updated_at=now() WHERE id=$1",
        [v.resource_id],
      );
      await this.audit(c, actor, "prompt.version_published", versionId, {
        resourceId: v.resource_id,
        version: v.version,
        changeNote: note,
        revision: v.revision + 1,
      });
      return { ok: true, version: v.version };
    });
  }
  async rollout(actor: number, versionId: number, environment: string) {
    const env = this.parse(environmentSchema, environment);
    return this.db.transaction(async (c) => {
      const v = await this.version(c, versionId);
      if (v.status !== "published")
        throw new ConflictException("只能发布已验证的 Prompt 版本");
      const r = await this.resource(c, v.resource_id);
      this.assertBusiness(r.promptKey);
      await c.query(
        "INSERT INTO prompt_environment_bindings(environment,resource_id,version_id,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(environment,resource_id) DO UPDATE SET version_id=EXCLUDED.version_id,updated_by=EXCLUDED.updated_by,updated_at=now()",
        [env, v.resource_id, versionId, actor],
      );
      await this.audit(c, actor, "prompt.rollout", versionId, {
        resourceId: v.resource_id,
        environment: env,
        version: v.version,
        legacyBusinessBinding: !isPlatform(r.promptKey),
      });
      return { ok: true, environment: env, version: v.version };
    });
  }
  async active(environment: string, key: string, query: Query = this.db) {
    if (key === "conversation.summary" || isPlatform(key)) return null;
    const env = this.parse(environmentSchema, environment);
    return (
      (
        await query.query<any>(
          `SELECT v.id::int AS "versionId",v.version,v.template,v.variables,r.id::int AS "resourceId",r.prompt_key AS "promptKey" FROM prompt_environment_bindings b JOIN prompt_resources r ON r.id=b.resource_id JOIN prompt_versions v ON v.id=b.version_id WHERE b.environment=$1 AND r.prompt_key=$2 AND r.archived_at IS NULL`,
          [env, key],
        )
      ).rows[0] ?? null
    );
  }
  private assertDraft(v: any, revision?: number) {
    if (v.status !== "draft")
      throw new ConflictException("已发布版本不可修改，请编辑新草稿");
    if (revision !== undefined && v.revision !== revision)
      throw new ConflictException(
        "草稿已被其他操作修改，请刷新后重新编辑或审阅",
      );
  }
  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const p = schema.safeParse(body);
    if (!p.success)
      throw new BadRequestException(
        p.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      );
    return p.data;
  }
  private async resource(db: Query, id: number, lock = false): Promise<any> {
    const r = (
      await db.query<any>(
        `SELECT r.id::int,r.prompt_key AS "promptKey",r.name,r.prompt_type AS "promptType",r.description,r.archived_at AS "archivedAt",r.updated_at AS "updatedAt" FROM prompt_resources r WHERE r.id=$1 AND ${allowed}${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Prompt 资源不存在");
    if (lock && r.archivedAt) throw new ConflictException("Prompt resource is archived and read-only");
    if (lock) this.assertBusiness(r.promptKey);
    return r;
  }
  private async version(db: Query, id: number, lock = false): Promise<any> {
    const r = (
      await db.query<any>(
        `SELECT v.*,v.id::int AS id,v.resource_id::int AS resource_id,r.archived_at AS "archivedAt",r.prompt_key AS "promptKey" FROM prompt_versions v JOIN prompt_resources r ON r.id=v.resource_id WHERE v.id=$1 AND ${allowed}${lock ? " FOR UPDATE OF v" : ""}`,
        [id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("Prompt 版本不存在");
    if (lock && r.archivedAt) throw new ConflictException("Prompt resource is archived and read-only");
    if (lock) this.assertBusiness(r.promptKey);
    return r;
  }
  private assertBusiness(key: string) {
    if (isPlatform(key)) throw new ConflictException("内部模板已停用，仅保留历史记录，不支持编辑或发布");
  }
  private async audit(
    c: Query,
    actor: number,
    action: string,
    id: number,
    details: unknown,
  ) {
    await c.query(
      "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,'prompt_version',$3,$4)",
      [actor, action, String(id), JSON.stringify(details)],
    );
  }
}
