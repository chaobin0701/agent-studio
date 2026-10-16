import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { SecretBox } from "../security/secret-box";
import {
  credentialSchema,
  mcpConnectionSchema,
  type ToolCredential,
  type McpConnectionConfig,
} from "./tool-config";
import {
  assertToolUrl,
  redactToolData,
  toolFetch,
  ToolNetworkError,
} from "./network";
import {
  withRemoteMcp,
  discoverMcp,
  callMcp,
  contractHash,
  mcpResourceKey,
  type McpDefinition,
} from "./remote-mcp";
import type {
  ResourceVersion,
  ToolSpec,
} from "../agent-management/resource.types";
import { keySchema, toolSchema } from "../agent-management/resource.types";
import { makeManagedTool } from "../agent-management/managed-tool";
import type { AgentTool } from "../ai/tools/agent-tool";
import type { ToolResult } from "../ai/tools/tool-result";
import { AppConfigService } from "../config/config.service";

import {
  lifecycleWriteLock,
  resourceState,
  statePredicate,
  resourceReferences,
  changeResourceLifecycle,
  type ResourceState,
} from "../agent-management/resource-lifecycle";

type Query = Pick<DatabaseService, "query">;
type ConnectionVersion = {
  id: number;
  serverId: number;
  version: number;
  key: string;
  name: string;
  enabled: boolean;
  archivedAt?: Date | null;
  deletedAt?: Date | null;
  config: McpConnectionConfig;
  catalog: McpDefinition[];
};
const versionSelect = `SELECT v.id::int,v.server_id::int AS "serverId",v.version,s.server_key AS key,s.name,s.enabled,s.archived_at AS "archivedAt",s.deleted_at AS "deletedAt",v.config,v.catalog,v.created_at AS "createdAt"
 FROM mcp_server_versions v JOIN mcp_servers s ON s.id=v.server_id`;
export function externalToolError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof ToolNetworkError)
    return { errorCode: error.code, content: error.message };
  if (message === "mcp_contract_changed")
    return {
      errorCode: message,
      content: "MCP 工具契约发生变化，请重新获取并审核工具",
    };
  if (message === "tool_credential_unavailable")
    return { errorCode: message, content: "工具凭证已停用或不存在" };
  if (message === "mcp_server_disabled")
    return { errorCode: message, content: "MCP 服务已停用" };
  if (
    /abort|timeout/i.test(message) ||
    (error instanceof Error && /abort|timeout/i.test(error.name))
  )
    return { errorCode: "tool_timeout", content: "工具调用超时或已取消" };
  if (/401|403|unauthorized/i.test(message))
    return {
      errorCode: "tool_auth_failed",
      content: "服务认证失败，请检查凭证和访问权限",
    };
  if (/429/.test(message))
    return { errorCode: "rate_limited", content: "服务限流，请稍后重试" };
  if (/ENOTFOUND|EAI_AGAIN|ECONN|502|503|504/.test(message))
    return {
      errorCode: "service_unavailable",
      content: "服务暂时不可连接，请检查地址和网络",
    };
  if (
    [
      "invalid_tool_header",
      "invalid_tool_mapping",
      "missing_tool_path_parameter",
      "tool_response_too_large",
    ].includes(message)
  )
    return {
      errorCode: message,
      content: "请求映射或响应大小不符合工具配置，请检查配置",
    };
  return {
    errorCode: "external_tool_failed",
    content: "外部工具调用失败，请检查服务、协议和参数配置",
  };
}
export function classifyToolOutcome(
  spec: ToolSpec,
  result: ToolResult,
): ToolResult {
  if (
    !result.success &&
    !spec.readOnly &&
    !spec.idempotencyHeader &&
    ["tool_timeout", "service_unavailable"].includes(result.errorCode ?? "")
  )
    return {
      ...result,
      errorCode: "tool_outcome_unknown",
      content:
        "写入调用超时或连接中断，无法确认是否已执行，请核查业务结果；不会自动重复调用。",
      metadata: { ...result.metadata, outcomeUnknown: true },
    };
  return result;
}

@Injectable()
export class ToolManagementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretBox,
    @Optional() private readonly runtime?: AppConfigService,
  ) {}
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    return parsed.data;
  }
  private async audit(
    c: Query,
    actor: number,
    action: string,
    id: number,
    details: unknown = {},
  ) {
    await c.query(
      "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,'external_tool',$3,$4)",
      [actor, action, String(id), JSON.stringify(details)],
    );
  }
  async credentials() {
    return {
      credentials: (
        await this.db.query(
          'SELECT id::int,name,kind,header,enabled,revision,created_at AS "createdAt" FROM tool_credentials ORDER BY id DESC',
        )
      ).rows,
    };
  }
  async createCredential(actor: number, body: unknown) {
    const input = this.parse(credentialSchema, body);
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      const row = (
        await c.query(
          "INSERT INTO tool_credentials(name,kind,header,encrypted_secret,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id::int",
          [
            input.name,
            input.kind,
            input.header,
            this.secrets.encrypt(input.secret),
            actor,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, "tool_credential.created", row.id);
      return row;
    });
  }
  async updateCredential(actor: number, id: number, body: unknown) {
    const input = this.parse(
      z
        .object({
          revision: z.number().int().positive(),
          secret: z
            .string()
            .min(1)
            .max(8000)
            .refine((v) => !/[\r\n]/.test(v))
            .optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
      body,
    );
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      const row = (
        await c.query(
          "UPDATE tool_credentials SET encrypted_secret=COALESCE($3,encrypted_secret),enabled=COALESCE($4,enabled),revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING id::int,revision",
          [
            id,
            input.revision,
            input.secret ? this.secrets.encrypt(input.secret) : null,
            input.enabled ?? null,
          ],
        )
      ).rows[0];
      if (!row) throw new ConflictException("凭证不存在或已更新，请刷新");
      await this.audit(c, actor, "tool_credential.updated", id, {
        rotated: !!input.secret,
        enabled: input.enabled,
      });
      return row;
    });
  }
  async credential(id: number): Promise<ToolCredential> {
    const row = (
      await this.db.query(
        "SELECT kind,header,encrypted_secret FROM tool_credentials WHERE id=$1 AND enabled",
        [id],
      )
    ).rows[0];
    if (!row) throw new Error("tool_credential_unavailable");
    return {
      kind: row.kind,
      header: row.header,
      secret: this.secrets.decrypt(row.encrypted_secret),
    };
  }
  private async validateConnection(config: McpConnectionConfig) {
    this.validateUrl(config.url);
    if (config.credentialId)
      try {
        await this.credential(config.credentialId);
      } catch {
        throw new BadRequestException("凭证不存在、已停用或不属于当前工作区");
      }
  }
  private validateUrl(url: string) {
    try {
      assertToolUrl(url);
    } catch (error) {
      throw new BadRequestException(externalToolError(error).content);
    }
  }
  async servers(state: ResourceState = "active") {
    resourceState(state);
    return {
      servers: (
        await this.db.query(
          `SELECT s.id::int,s.server_key AS key,s.name,s.enabled,s.archived_at AS "archivedAt",s.deleted_at AS "deletedAt",
      v.id::int AS "versionId",v.version,v.config,jsonb_array_length(v.catalog) AS "toolCount"
      FROM mcp_servers s JOIN LATERAL(SELECT * FROM mcp_server_versions WHERE server_id=s.id ORDER BY version DESC LIMIT 1)v ON true WHERE ${statePredicate("s")} ORDER BY s.id DESC`,
          [state],
        )
      ).rows,
    };
  }
  async server(id: number) {
    const versions = (
      await this.db.query<ConnectionVersion>(
        versionSelect + " WHERE s.id=$1 ORDER BY v.version DESC",
        [id],
      )
    ).rows;
    if (!versions.length) throw new NotFoundException("MCP 服务不存在");
    const resources = (
      await this.db.query(
        `SELECT r.id::int,r.resource_key AS key,r.name,r.enabled,v.id::int AS "versionId",v.status,v.config->>'target' AS "toolName",(v.config->>'mcpVersionId')::int AS "mcpVersionId"
      FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id WHERE r.kind='tool' AND (v.config->>'mcpVersionId')::bigint=ANY($1::bigint[]) ORDER BY r.id,v.version DESC`,
        [versions.map((v) => v.id)],
      )
    ).rows;
    return {
      id,
      key: versions[0].key,
      name: versions[0].name,
      enabled: versions[0].enabled,
      archivedAt: versions[0].archivedAt ?? null,
      deletedAt: versions[0].deletedAt ?? null,
      versions,
      resources,
    };
  }
  async connectionVersion(id: number): Promise<ConnectionVersion> {
    const row = (
      await this.db.query<ConnectionVersion>(versionSelect + " WHERE v.id=$1", [
        id,
      ])
    ).rows[0];
    if (!row || row.archivedAt || row.deletedAt)
      throw new NotFoundException("MCP 服务版本不存在或不属于当前工作区");
    return { ...row, config: this.parse(mcpConnectionSchema, row.config) };
  }
  async createServer(actor: number, body: unknown) {
    const input = this.parse(
      z
        .object({
          key: keySchema,
          name: z.string().trim().min(1).max(120),
          config: mcpConnectionSchema,
        })
        .strict(),
      body,
    );
    await this.validateConnection(input.config);
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      const row = (
        await c.query(
          "INSERT INTO mcp_servers(server_key,name) VALUES($1,$2) ON CONFLICT(workspace_id,server_key) DO NOTHING RETURNING id::int",
          [input.key, input.name],
        )
      ).rows[0];
      if (!row) throw new ConflictException("MCP 服务 Key 已存在");
      await c.query(
        "INSERT INTO mcp_server_versions(server_id,version,config,created_by) VALUES($1,1,$2,$3)",
        [row.id, JSON.stringify(input.config), actor],
      );
      await this.audit(c, actor, "mcp_server.created", row.id);
      return row;
    });
  }
  private async appendVersion(
    actor: number,
    id: number,
    expectedVersionId: number,
    config: McpConnectionConfig,
    catalog: McpDefinition[],
    action: string,
  ) {
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      if (
        !(
          await c.query(
            "SELECT id FROM mcp_servers WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE",
            [id],
          )
        ).rows.length
      )
        throw new NotFoundException("MCP 服务不存在");
      const current = (
        await c.query(
          "SELECT id::int,version FROM mcp_server_versions WHERE server_id=$1 ORDER BY version DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      if (!current || current.id !== expectedVersionId)
        throw new ConflictException("服务配置已更新，请刷新后重试");
      const row = (
        await c.query(
          "INSERT INTO mcp_server_versions(server_id,version,config,catalog,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id::int,version",
          [
            id,
            current.version + 1,
            JSON.stringify(config),
            JSON.stringify(catalog),
            actor,
          ],
        )
      ).rows[0];
      await this.audit(c, actor, action, id, {
        versionId: row.id,
        toolCount: catalog.length,
      });
      return row;
    });
  }
  async configureServer(actor: number, id: number, body: unknown) {
    const input = this.parse(
      z
        .object({
          versionId: z.number().int().positive(),
          config: mcpConnectionSchema,
        })
        .strict(),
      body,
    );
    await this.validateConnection(input.config);
    return this.appendVersion(
      actor,
      id,
      input.versionId,
      input.config,
      [],
      "mcp_server.configured",
    );
  }
  async references(id: number) {
    return { references: await resourceReferences(this.db, "mcp", id) };
  }
  async lifecycle(
    actor: number,
    id: number,
    action: "archive" | "delete" | "restore",
  ) {
    return this.db.transaction((c) =>
      changeResourceLifecycle(c, actor, "mcp", id, action),
    );
  }
  async serverStatus(actor: number, id: number, enabled: boolean) {
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      if (enabled) {
        const latest = (
          await c.query(
            "SELECT id::int FROM mcp_server_versions WHERE server_id=$1 ORDER BY version DESC LIMIT 1",
            [id],
          )
        ).rows[0];
        if (!latest) throw new NotFoundException("MCP 服务不存在");
        const version = await this.connectionVersion(latest.id);
        await this.validateConnection(version.config);
      }
      if (
        !(
          await c.query(
            "UPDATE mcp_servers SET enabled=$2 WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL RETURNING id",
            [id, enabled],
          )
        ).rows.length
      )
        throw new NotFoundException("MCP 服务不存在");
      await this.audit(c, actor, "mcp_server.status", id, { enabled });
      return { ok: true };
    });
  }
  async probe(actor: number, id: number, body: unknown, discover = false) {
    const { versionId } = this.parse(
      z.object({ versionId: z.number().int().positive() }).strict(),
      body,
    );
    const version = await this.connectionVersion(versionId);
    if (version.serverId !== id)
      throw new BadRequestException("服务版本不匹配");
    if (!version.enabled) throw new BadRequestException("MCP 服务已停用");
    const started = Date.now();
    let catalog: McpDefinition[];
    try {
      await this.validateConnection(version.config);
      const credential = version.config.credentialId
        ? await this.credential(version.config.credentialId)
        : undefined;
      catalog = await withRemoteMcp(
        version.config,
        credential,
        undefined,
        (client) => discoverMcp(client),
      );
      if (Buffer.byteLength(JSON.stringify(catalog)) > 1024 * 1024)
        throw new Error("mcp_catalog_too_large");
    } catch (error) {
      const failure = {
        ok: false,
        ...externalToolError(error),
        durationMs: Date.now() - started,
      };
      await this.audit(this.db, actor, "mcp_server.tested", id, failure);
      return failure;
    }
    if (discover) {
      const added = await this.appendVersion(
        actor,
        id,
        versionId,
        version.config,
        catalog,
        "mcp_server.discovered",
      );
      return {
        ok: true,
        ...added,
        toolCount: catalog.length,
        durationMs: Date.now() - started,
      };
    }
    const result = {
      ok: true,
      toolCount: catalog.length,
      durationMs: Date.now() - started,
      message: "连接和工具协议验证通过",
    };
    await this.audit(this.db, actor, "mcp_server.tested", id, result);
    return result;
  }
  async importTool(actor: number, id: number, body: unknown) {
    const input = this.parse(
      z
        .object({
          versionId: z.number().int().positive(),
          toolName: z.string().min(1).max(128),
        })
        .strict(),
      body,
    );
    const version = await this.connectionVersion(input.versionId);
    if (version.serverId !== id || !version.enabled)
      throw new BadRequestException("服务不存在或已停用");
    const definition = version.catalog.find(
      (tool) => tool.name === input.toolName,
    );
    if (!definition) throw new BadRequestException("请先获取此版本的工具列表");
    const key = mcpResourceKey(version.key, definition.name);
    const config = toolSchema.parse({
      type: "mcp",
      target: definition.name,
      mcpVersionId: version.id,
      description: definition.description ?? definition.name,
      parameters: definition.inputSchema,
      outputSchema: definition.outputSchema,
      readOnly: false,
      requiresApproval: true,
      maxRetries: 0,
      timeoutMs: version.config.timeoutMs,
    });
    return this.db.transaction(async (c) => {
      await lifecycleWriteLock(c);
      await this.connectionVersion(input.versionId);
      const existing = (
        await c.query(
          "SELECT archived_at,deleted_at FROM agent_resources WHERE kind='tool' AND resource_key=$1",
          [key],
        )
      ).rows[0];
      if (existing?.archived_at || existing?.deleted_at)
        throw new ConflictException("同名 Tool 已归档或删除，请先恢复后再导入");
      const resource = (
        await c.query(
          "INSERT INTO agent_resources(kind,resource_key,name) VALUES('tool',$1,$2) ON CONFLICT(workspace_id,kind,resource_key) DO UPDATE SET resource_key=EXCLUDED.resource_key RETURNING id::int",
          [key, `${version.name} · ${definition.name}`.slice(0, 160)],
        )
      ).rows[0];
      await c.query("SELECT id FROM agent_resources WHERE id=$1 FOR UPDATE", [
        resource.id,
      ]);
      const duplicate = (
        await c.query(
          "SELECT id::int FROM agent_resource_versions WHERE resource_id=$1 AND (config->>'mcpVersionId')::bigint=$2 ORDER BY version DESC LIMIT 1",
          [resource.id, version.id],
        )
      ).rows[0];
      if (duplicate)
        return {
          resourceId: resource.id,
          versionId: duplicate.id,
          reused: true,
        };
      const next = (
        await c.query(
          "SELECT COALESCE(max(version),0)+1 AS n FROM agent_resource_versions WHERE resource_id=$1",
          [resource.id],
        )
      ).rows[0].n;
      const row = (
        await c.query(
          "INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,$2,$3) RETURNING id::int",
          [resource.id, next, JSON.stringify(config)],
        )
      ).rows[0];
      await this.audit(c, actor, "mcp_tool.imported", resource.id, {
        serverId: id,
        mcpVersionId: version.id,
        toolName: definition.name,
      });
      return { resourceId: resource.id, versionId: row.id, reused: false };
    });
  }
  async validateTool(spec: ToolSpec) {
    if (spec.type === "rest") {
      this.validateUrl(spec.endpoint!.url);
      if (spec.endpoint!.credentialId)
        try {
          await this.credential(spec.endpoint!.credentialId);
        } catch {
          throw new BadRequestException("工具凭证不可用或不属于当前工作区");
        }
      const properties = spec.parameters.properties as
        | Record<string, unknown>
        | undefined;
      if (
        spec.endpoint!.mappingMode === "explicit" &&
        spec.endpoint!.bindings.some(
          (binding) =>
            !properties || !Object.hasOwn(properties, binding.source),
        )
      )
        throw new BadRequestException("请求映射引用了未声明的输入参数");
      const pathTargets = new Set(
        spec
          .endpoint!.bindings.filter((b) => b.location === "path")
          .map((b) => b.target),
      );
      for (const name of spec.endpoint!.url.matchAll(
        /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
      ))
        if (!pathTargets.has(name[1]))
          throw new BadRequestException(`路径参数 ${name[1]} 缺少映射`);
    }
    if (spec.outputSchema)
      try {
        z.fromJSONSchema(spec.outputSchema as any);
      } catch {
        throw new BadRequestException("输出 JSON Schema 无法解析");
      }
    if (spec.type === "mcp" && spec.mcpVersionId) {
      const version = await this.connectionVersion(spec.mcpVersionId);
      if (!version.enabled) throw new BadRequestException("MCP 服务已停用");
      const definition = version.catalog.find(
        (tool) => tool.name === spec.target,
      );
      if (
        !definition ||
        contractHash(definition.inputSchema) !==
          contractHash(spec.parameters) ||
        contractHash(definition.outputSchema ?? null) !==
          contractHash(spec.outputSchema ?? null)
      )
        throw new BadRequestException(
          "MCP 原生参数和输出契约不能手工修改，请重新获取工具",
        );
      if (!spec.readOnly && spec.maxRetries > 0)
        throw new BadRequestException("MCP 写入工具暂不支持自动重试");
    }
  }
  async managedTool(
    v: ResourceVersion,
    lookup: (key: string) => AgentTool,
  ): Promise<AgentTool> {
    const spec = v.config as ToolSpec;
    v = { ...v, config: spec };
    let base: AgentTool | undefined;
    if (spec.type === "mcp" && spec.mcpVersionId) {
      const version = await this.connectionVersion(spec.mcpVersionId);
      const definition = version.catalog.find(
        (tool) => tool.name === spec.target,
      );
      if (!definition)
        throw new BadRequestException("MCP 工具未在已审核目录中");
      base = {
        execution: {
          channel: "tools",
          source: "mcp",
          mcpServerId: version.serverId,
        },
        name: v.key,
        description: spec.description,
        inputSchema: z.fromJSONSchema(definition.inputSchema as any),
        planning: { canBatch: spec.readOnly, isIdempotent: spec.readOnly },
        execute: async (input: any, context) => {
          try {
            const live = await this.connectionVersion(version.id);
            if (!live.enabled) throw new Error("mcp_server_disabled");
            const credential = version.config.credentialId
              ? await this.credential(version.config.credentialId)
              : undefined;
            const result = await withRemoteMcp(
              version.config,
              credential,
              context.signal,
              (client) => callMcp(client, definition, input, context.signal),
            );
            const data = redactToolData(
              result.structuredContent,
              credential ? [credential.secret] : [],
            );
            const content = redactToolData(
              result.content
                .filter((block) => block.type === "text")
                .map((block) => (block as { text: string }).text)
                .join("\n"),
              credential ? [credential.secret] : [],
            );
            if (
              definition.outputSchema &&
              data !== undefined &&
              !z.fromJSONSchema(definition.outputSchema as any).safeParse(data)
                .success
            )
              return {
                success: false,
                content: "MCP 返回内容不符合输出契约",
                errorCode: "tool_output_invalid",
              };
            return {
              success: !result.isError,
              content: (content || JSON.stringify(data ?? {})).slice(0, 50000),
              data,
              ...(result.isError ? { errorCode: "mcp_tool_failed" } : {}),
            };
          } catch (error) {
            return { success: false, ...externalToolError(error) };
          }
        },
      };
    }
    const managed = makeManagedTool(v, (key) => base ?? lookup(key), {
      fetch: toolFetch,
      credential: (id) => this.credential(id),
    });
    const execute = managed.execute.bind(managed);
    return {
      ...managed,
      execute: async (input, context) => {
        try {
          return classifyToolOutcome(spec, await execute(input, context));
        } catch (error) {
          return classifyToolOutcome(spec, {
            success: false,
            ...externalToolError(error),
          });
        }
      },
    };
  }
}
