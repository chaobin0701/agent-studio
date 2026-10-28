import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { AgentManagementService } from "../agent-management/agent-management.service";
import {
  compositionMetadata,
  freeze,
  runtimeScope,
  type CompositionSnapshot,
} from "../agent-management/runtime-scope";
import {
  IntegrationService,
  credentialHash,
} from "../integrations/integration.service";
import type { IntegrationCallResult } from "../integrations/integration.types";
import { workspaceAccess } from "../workspaces/workspace-access";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import { LlmService } from "../chat/llm.service";
import { withModelCallAccounting } from "../chat/model-call-accounting";
import {
  configuredExecutionBudget,
  SharedExecutionBudget,
  withExecutionBudget,
} from "../ai/agent/execution-budget";
import { nativeSystemPrompt } from "../ai/deep-agents/deep-agent-execution.service";
import { ToolExecutionService } from "../ai/tools/tool-execution";
import {
  withWorkflowHost,
  type WorkflowHost,
} from "../ai/workflows/workflow-host";
import { ExecutionTracingService } from "../observability/tracing.module";
import { annotateExecution } from "../observability/execution-tracer";
import { redactToolData } from "../tool-management/network";
import { publicIntegrationError } from "../integrations/quota-error";

export const workflowTestInput = z
  .object({
    applicationId: z.string().uuid(),
    agentVersionId: z.number().int().positive(),
    contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.string().uuid(),
    input: z.record(z.string(), z.unknown()),
    approved: z.boolean().default(false),
    approvedToolVersionIds: z
      .array(z.number().int().positive())
      .max(40)
      .default([])
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "批准的工具版本不能重复",
      ),
  })
  .strict();
type TestResult = IntegrationCallResult & {
  ok: boolean;
  errorCode: string | null;
  content: string;
  durationMs: number;
  agentId: number;
  agentVersionId: number;
  toolVersionId: number;
};
type Draft = Awaited<ReturnType<AgentManagementService["prepareToolTest"]>>;
/** Optimistic configuration revision, not an authorization token. */
export function workflowContextFingerprint(
  draft: Draft,
  composition: CompositionSnapshot,
) {
  const { createdAt: _createdAt, ...pinned } = compositionMetadata(composition);
  return credentialHash(
    JSON.stringify({
      id: draft.version.id,
      revision: draft.version.revision,
      signature: draft.signature,
      workflow: draft.tool.execution?.workflow,
      composition: pinned,
    }),
  );
}
type Dependency = {
  key: string;
  name: string;
  versionId: number;
  requiresApproval: boolean;
  readOnly: boolean;
};

/** A bounded administrative edge into the existing workflow host, not an Agent
 * planner, free SDK executor, new ledger or public credential bypass. */
@Injectable()
export class WorkflowTestService {
  private readonly logger = new Logger(WorkflowTestService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly management: AgentManagementService,
    private readonly access: IntegrationService,
    private readonly llm: LlmService,
    private readonly gateway: ToolExecutionService,
    private readonly tracing: ExecutionTracingService,
  ) {}

  private async permission(actor: number) {
    const codes = (await workspaceAccess(this.db, actor, currentWorkspaceId()))
      .permissionCodes;
    if (
      !["agent_config.manage", "agent_tools.execute"].every((p) =>
        codes.includes(p),
      )
    )
      throw new ForbiddenException("需要配置管理和工具执行权限");
  }
  private workflow(draft: Draft) {
    const workflow = draft.tool.execution?.workflow;
    if (!workflow) throw new BadRequestException("当前工具不是专项流程");
    return workflow;
  }
  private async context(draft: Draft, applicationId: string) {
    const app = await this.access.app(applicationId);
    if (!app.enabled || !app.scopes.includes("chat:write"))
      throw new ConflictException("请选择启用且允许执行的接入应用");
    const composition = await this.management.snapshot(app.agentId);
    const agent = composition.agents.get(composition.entryVersionId)!;
    const dependencies: Dependency[] = [];
    for (const key of this.workflow(draft).requiredTools) {
      const tool = agent.tools.get(key);
      if (
        key === draft.tool.name ||
        !tool ||
        tool.execution?.workflow ||
        ["run_skill", "delegate_agent", "load_skill"].includes(key)
      )
        throw new BadRequestException(`该 Agent 未授权流程依赖工具：${key}`);
      const versionId = tool.execution?.toolVersionId;
      if (!versionId)
        throw new BadRequestException("流程依赖必须使用已发布的管理工具版本");
      await this.management.assertTestToolAvailable(versionId);
      const row = (
        await this.db.query<{
          name: string;
          config: { requiresApproval: boolean; readOnly: boolean };
        }>(
          "SELECT r.name,v.config FROM agent_resource_versions v JOIN agent_resources r ON r.id=v.resource_id WHERE v.id=$1",
          [versionId],
        )
      ).rows[0];
      if (!row) throw new ConflictException("流程依赖已不可用");
      dependencies.push({
        key,
        name: row.name,
        versionId,
        requiresApproval: row.config.requiresApproval,
        readOnly: row.config.readOnly,
      });
    }
    return { app, composition, agent, dependencies };
  }
  async options(actor: number, id: number, applicationId?: string) {
    await this.permission(actor);
    if (applicationId && !z.string().uuid().safeParse(applicationId).success)
      throw new BadRequestException("接入应用 ID 无效");
    const draft = await this.management.prepareToolTest(id),
      workflow = this.workflow(draft);
    const applications = (
      await this.db
        .query(`SELECT a.id,a.name,r.id::int AS "agentId",r.name AS "agentName",v.id::int AS "agentVersionId",v.version
      FROM integration_apps a JOIN agent_resources r ON r.id=a.agent_id JOIN agent_resource_versions v ON v.id=r.current_version_id
      WHERE a.enabled AND 'chat:write'=ANY(a.scopes) AND r.enabled AND r.kind='agent' AND r.archived_at IS NULL AND r.deleted_at IS NULL AND v.status='published'
      ORDER BY a.is_internal DESC,a.created_at DESC LIMIT 200`)
    ).rows;
    if (!applicationId)
      return {
        workflow,
        applications,
        requiresApproval: !!draft.version.config.requiresApproval,
      };
    const context = await this.context(draft, applicationId);
    return {
      workflow,
      applications,
      requiresApproval: !!draft.version.config.requiresApproval,
      selected: {
        applicationId: context.app.id,
        agentId: context.composition.agentId,
        agentVersionId: context.agent.version.id,
        contextFingerprint: workflowContextFingerprint(
          draft,
          context.composition,
        ),
        modelPlanName: context.agent.modelPlan?.name ?? "",
        modelPlanVersion: context.agent.modelPlan?.version ?? null,
        modelPlanVersionId: context.agent.modelPlan?.id ?? null,
        promptVersionId: context.agent.spec.promptVersionId,
        dependencies: context.dependencies,
        limits: configuredExecutionBudget(
          context.agent.spec.runtime,
          context.composition.collaboration,
          context.agent.spec.executionLimits,
        ),
      },
    };
  }
  async execute(
    actor: number,
    id: number,
    value: unknown,
    transport?: AbortSignal,
  ): Promise<TestResult> {
    await this.permission(actor);
    const parsed = workflowTestInput.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException(
        "请指定应用、生效 Agent 版本、请求 ID 和有效测试参数",
      );
    const input = parsed.data,
      draft = await this.management.prepareToolTest(id);
    this.workflow(draft);
    if (!draft.tool.inputSchema.safeParse(input.input).success)
      throw new BadRequestException("测试参数未通过工具 Schema 校验");
    const { app, composition, agent, dependencies } = await this.context(
      draft,
      input.applicationId,
    );
    if (agent.version.id !== input.agentVersionId)
      throw new ConflictException("Agent 生效版本已更改，请重新选择测试上下文");
    if (
      input.contextFingerprint !==
      workflowContextFingerprint(draft, composition)
    )
      throw new ConflictException(
        "流程草稿或实际模型配置已更改，请重新选择测试上下文",
      );
    const required = dependencies
      .filter((d) => d.requiresApproval)
      .map((d) => d.versionId);
    if (input.approvedToolVersionIds.some((id) => !required.includes(id)))
      throw new BadRequestException(
        "只能批准流程声明且 Agent 已授权的依赖工具",
      );
    if (
      required.some((id) => !input.approvedToolVersionIds.includes(id)) ||
      (draft.version.config.requiresApproval && !input.approved)
    )
      throw new BadRequestException(
        "请逐项确认需要批准的工具，测试可能产生真实副作用",
      );
    const { createdAt: _createdAt, ...pinnedComposition } =
      compositionMetadata(composition);
    const fingerprint = credentialHash(
      JSON.stringify({
        kind: "workflow_test",
        actor,
        id,
        revision: draft.version.revision,
        signature: draft.signature,
        workflow: this.workflow(draft),
        agent: pinnedComposition,
        input: input.input,
        approved: input.approved,
        approvedTools: [...input.approvedToolVersionIds].sort((a, b) => a - b),
      }),
    );
    const admission = await this.access.admitManagedTest<TestResult>(
      app.id,
      actor,
      composition.agentId,
      fingerprint,
      input.requestId,
    );
    if (admission.cached) return admission.cached;
    const runId = admission.callId,
      traceId = randomUUID(),
      started = Date.now();
    const budget = new SharedExecutionBudget(
      configuredExecutionBudget(
        agent.spec.runtime,
        composition.collaboration,
        agent.spec.executionLimits,
      ),
    );
    const limits = configuredExecutionBudget(
      agent.spec.runtime,
      composition.collaboration,
      agent.spec.executionLimits,
    );
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        Math.min(
          120000,
          draft.version.config.timeoutMs,
          agent.spec.runtime.toolTimeoutMs,
        ),
      ),
      ...(transport ? [transport] : []),
    ]);
    const permissions = [draft.tool.name, ...dependencies.map((d) => d.key)];
    const tools = new Map(agent.tools);
    // A config manager explicitly tests this draft target; dependencies still
    // come exclusively from the immutable published entry Agent snapshot.
    for (const key of permissions) {
      const original = key === draft.tool.name ? draft.tool : tools.get(key)!;
      const versionId = original.execution!.toolVersionId!;
      tools.set(key, {
        ...original,
        execute: async (args, context) => {
          signal.throwIfAborted();
          await this.management.assertTestToolAvailable(
            versionId,
            key !== draft.tool.name,
          );
          return original.execute(args, context);
        },
      });
    }
    const scope = freeze({ ...agent, tools });
    const state = this.gateway.createStateForAgent(
      permissions,
      Math.min(agent.spec.runtime.maxToolCalls, limits.maxToolCalls),
      {
        timeoutMs: Math.min(
          draft.version.config.timeoutMs,
          agent.spec.runtime.toolTimeoutMs,
        ),
        maxResultChars: agent.spec.runtime.maxToolResultChars,
      },
    );
    const versions = {
      workspaceId: composition.workspaceId,
      agentId: composition.agentId,
      agentVersionId: agent.version.id,
      toolVersionId: id,
      promptVersionId: agent.spec.promptVersionId,
      modelPlanVersionId: agent.modelPlan?.id ?? null,
      localRunId: runId,
      localTraceId: traceId,
    };
    const context: Record<string, any> = {
      entryPoint: "workflow_test",
      executionEngine: "langgraph",
      executionInput: { versions, limits },
      agentComposition: compositionMetadata(composition),
      executionSteps: [],
      modelCalls: [],
      toolCalls: [],
      specializedFlows: [],
      graphNodes: [],
    };
    const host: WorkflowHost = {
      llm: this.llm,
      gateway: this.gateway,
      tools: [...tools.values()],
      signal,
      versions,
      systemPrompt: nativeSystemPrompt(agent),
      toolState: state,
      toolContext: {
        traceId,
        tenantId: String(composition.workspaceId),
        userId: String(actor),
        permissions,
        signal,
        state: new Map(),
        approvedTools: [
          ...(input.approved ? [draft.tool.name] : []),
          ...dependencies
            .filter((d) => input.approvedToolVersionIds.includes(d.versionId))
            .map((d) => d.key),
        ],
      },
      onModel: (model) => {
        const record = {
          purpose: "planner",
          ok: true,
          model: model.model,
          durationMs: model.durationMs,
          attempts: model.attempts,
          attemptsTrail: model.attemptsTrail,
          response: {
            finishReason: model.finishReason,
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            totalTokens: model.totalTokens,
          },
        };
        context.modelCalls.push(record);
        context.executionSteps.push({ type: "llm_call", ...record });
      },
      onModelFailure: (failure) => {
        context.modelCalls.push({ purpose: "planner", ...failure });
        context.executionSteps.push({ type: "llm_call", ...failure });
      },
      onTool: (_name, _callId, outcome) => {
        context.toolCalls.push(outcome.trace);
        context.executionSteps.push({
          type: "tool_call",
          origin: "workflow",
          ...outcome.trace,
        });
      },
      onWorkflow: (record) => context.specializedFlows.push(record),
    };
    try {
      await this.db.query(
        "UPDATE integration_calls SET trace_id=$2 WHERE id=$1",
        [runId, traceId],
      );
      await this.audit(actor, id, "workflow_test.started", {
        applicationId: app.id,
        agentVersionId: agent.version.id,
        runId,
        traceId,
        approvedToolVersionIds: input.approvedToolVersionIds,
      });
      return await this.tracing.span(
        "workflow_test",
        "chain",
        versions,
        async (span) => {
          context.externalTrace = this.tracing.link(span);
          const outcome = await runtimeScope.run(scope, () =>
            this.llm.withPinnedModelPlan(agent.modelPlan, () =>
              withModelCallAccounting(
                this.access.tokens.accounting(app.id, runId),
                () =>
                  withExecutionBudget(budget, () =>
                    withWorkflowHost(host, () =>
                      this.gateway.execute(
                        draft.tool.name,
                        input.input,
                        host.toolContext,
                        state,
                      ),
                    ),
                  ),
              ),
            ),
          );
          signal.throwIfAborted();
          host.onTool(draft.tool.name, runId, outcome);
          const result: TestResult = {
            ok: outcome.result.success,
            errorCode: outcome.result.errorCode ?? null,
            content: String(redactToolData(outcome.result.content)).slice(
              0,
              4000,
            ),
            durationMs: Date.now() - started,
            runId,
            traceId,
            agentId: composition.agentId,
            agentVersionId: agent.version.id,
            toolVersionId: id,
          };
          if (!result.ok)
            annotateExecution({
              status: "failed",
              errorCode: result.errorCode,
            });
          context.executionBudget = { ...limits, ...budget.counters };
          await this.management.recordToolTest(
            actor,
            draft.version,
            draft.signature,
            result,
          );
          await this.persist(app.id, traceId, draft.tool.name, context, result);
          await this.audit(actor, id, "workflow_test.finished", {
            runId,
            traceId,
            ok: result.ok,
            errorCode: result.errorCode,
          });
          const completed = await this.access.finish(
            runId,
            result.ok ? result : null,
          );
          return (
            completed ?? {
              ...result,
              usage: await this.access.tokens.callUsage(runId),
            }
          );
        },
      );
    } catch (error) {
      const code = signal.aborted
        ? transport?.aborted
          ? "run_cancelled"
          : "workflow_timeout"
        : (publicIntegrationError(error).code ?? "workflow_failed");
      annotateExecution({ status: "failed", errorCode: code });
      const result: TestResult = {
        ok: false,
        errorCode: code,
        content: "流程测试未完成，请检查执行记录；不会自动重放本次请求。",
        durationMs: Date.now() - started,
        runId,
        traceId,
        agentId: composition.agentId,
        agentVersionId: agent.version.id,
        toolVersionId: id,
      };
      context.executionBudget = { ...limits, ...budget.counters };
      context.errorSummary = { phase: "workflow_test", errorCode: code };
      if (!(error instanceof ConflictException))
        await this.management
          .recordToolTest(actor, draft.version, draft.signature, result)
          .catch(() =>
            this.logger.warn("Could not update workflow draft test status"),
          );
      await this.persist(
        app.id,
        traceId,
        draft.tool.name,
        context,
        result,
      ).catch(() => this.logger.warn("Failed to persist workflow test trace"));
      await this.access.finish(runId, null);
      await this.audit(actor, id, "workflow_test.failed", {
        runId,
        traceId,
        errorCode: code,
      }).catch(() => this.logger.warn("Failed to persist workflow test audit"));
      // Do not mark a concurrently changed draft as tested or expose provider bodies.
      if (error instanceof ConflictException) throw error;
      return { ...result, usage: await this.access.tokens.callUsage(runId) };
    }
  }
  private audit(
    actor: number,
    id: number,
    action: string,
    details: Record<string, unknown>,
  ) {
    return this.db.query(
      "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,'agent_resource',$3,$4)",
      [actor, action, String(id), JSON.stringify(details)],
    );
  }
  private async persist(
    appId: string,
    traceId: string,
    key: string,
    context: Record<string, unknown>,
    result: TestResult,
  ) {
    const usage = await this.access.tokens.callUsage(result.runId!);
    await this.db.query(
      `INSERT INTO chat_traces(id,application_id,question,context_snapshot,status,final_answer,refused,error_code,duration_ms,input_tokens,output_tokens,total_tokens)
      VALUES($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11)
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,error_code=EXCLUDED.error_code,context_snapshot=EXCLUDED.context_snapshot`,
      [
        traceId,
        appId,
        `专项流程测试：${key}`,
        JSON.stringify(context),
        result.ok ? "completed" : "failed",
        result.content,
        result.errorCode,
        result.durationMs,
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
      ],
    );
  }
}
