import { All, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { SystemMcpService } from "./system-mcp.service";

@Controller("mcp/system")
export class SystemMcpEndpointController {
  constructor(private readonly service: SystemMcpService) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    const credential = await this.service.authenticate(req.headers.authorization);
    const server = new McpServer({ name: "agent-studio-system", version: "1.0.0" });
    const workspace = z.number().int().positive().describe("Authorized workspace ID");
    server.registerTool("agents_list", { description: "List Agent names, versions and configuration references.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "agents.read", () => this.service.listAgents())) }],
    }));
    server.registerTool("agent_get", { description: "Read an Agent configuration snapshot; prompt bodies and credentials are excluded.", inputSchema: { workspace_id: workspace, agent_id: z.number().int().positive() } }, async ({ workspace_id, agent_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "agents.read", () => this.service.getAgent(agent_id))) }],
    }));
    server.registerTool("resources_list", { description: "List Agent, Skill, Tool and collaboration resources without secret values or embedded content.", inputSchema: { workspace_id: workspace, kind: z.enum(["agent", "skill", "tool", "collaboration"]).optional() } }, async ({ workspace_id, kind }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "agents.read", () => this.service.listResources(kind))) }],
    }));
    server.registerTool("resource_get", { description: "Read a versioned Agent-related resource; secret values and embedded content are redacted.", inputSchema: { workspace_id: workspace, resource_id: z.number().int().positive() } }, async ({ workspace_id, resource_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "agents.read", () => this.service.getResource(resource_id))) }],
    }));
    server.registerTool("prompts_list", { description: "List Prompt names and published version metadata.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "prompts.read", () => this.service.listPrompts())) }],
    }));
    server.registerTool("llm_models_list", { description: "List large language model plan metadata.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "models.read", () => this.service.listModels())) }],
    }));
    server.registerTool("embedding_models_list", { description: "List embedding model plan metadata.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "embeddings.read", () => this.service.listEmbeddings())) }],
    }));
    server.registerTool("audit_logs_list", { description: "Read recent workspace audit records.", inputSchema: { workspace_id: workspace, limit: z.number().int().min(1).max(100).default(50) } }, async ({ workspace_id, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "audit.read", () => this.service.listAudit(workspace_id, limit))) }],
    }));
    server.registerTool("recording_policy_get", { description: "Read platform recording controls. Required security audit and core conversation history are always retained.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await this.service.withScope(credential, workspace_id, "recording.read", () => this.service.getRecordingPolicy(credential.adminId))) }],
    }));
    const objectInput = z.record(z.string(), z.unknown());
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(this.service.safeConfiguration(value)) }] });
    server.registerTool("recording_policy_update", { description: "Update platform Trace recording controls using the existing policy validation.", inputSchema: { workspace_id: workspace, input: z.object({ auditEnabled: z.literal(true), conversationContentEnabled: z.boolean(), traceEnabled: z.boolean(), usageEnabled: z.boolean() }).strict() } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, "recording.manage", () => this.service.updateRecordingPolicy(credential.adminId, input))));
    server.registerTool("prompt_get", { description: "Read Prompt version metadata without Prompt bodies or variables.", inputSchema: { workspace_id: workspace, prompt_id: z.number().int().positive() } }, async ({ workspace_id, prompt_id }) => result(await this.service.withScope(credential, workspace_id, "prompts.read", () => this.service.getPrompt(prompt_id))));
    server.registerTool("agent_create", { description: "Create an Agent resource draft.", inputSchema: { workspace_id: workspace, input: objectInput } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.createResource(credential.adminId, input))));
    server.registerTool("agent_prepare_draft", { description: "Prepare a draft for an Agent.", inputSchema: { workspace_id: workspace, agent_id: z.number().int().positive(), from_version_id: z.number().int().positive().optional() } }, async ({ workspace_id, agent_id, from_version_id }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.agentDraft(credential.adminId, agent_id, { fromVersionId: from_version_id }))));
    server.registerTool("agent_update_draft", { description: "Update an Agent draft using the existing Agent management validation.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, version_id, input }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.updateResource(credential.adminId, version_id, input))));
    server.registerTool("agent_publish", { description: "Publish an Agent draft after existing validation and required tests pass.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive() } }, async ({ workspace_id, version_id }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.publishAgent(credential.adminId, version_id))));
    server.registerTool("resource_create", { description: "Create an Agent-related resource using existing resource validation.", inputSchema: { workspace_id: workspace, input: objectInput } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.createResource(credential.adminId, input))));
    server.registerTool("resource_prepare_draft", { description: "Prepare an existing Agent-related resource draft.", inputSchema: { workspace_id: workspace, resource_id: z.number().int().positive(), input: objectInput.optional() } }, async ({ workspace_id, resource_id, input }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.prepareResourceDraft(credential.adminId, resource_id, input ?? {}))));
    server.registerTool("resource_update_draft", { description: "Update a Skill, Tool or collaboration resource draft through the existing validation service.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, version_id, input }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.updateResource(credential.adminId, version_id, input))));
    server.registerTool("resource_publish", { description: "Publish an Agent-related resource draft through existing validation and test gates.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive() } }, async ({ workspace_id, version_id }) => result(await this.service.withScope(credential, workspace_id, "agents.manage", () => this.service.publishResource(credential.adminId, version_id))));
    server.registerTool("prompt_create", { description: "Create a Prompt using the existing Prompt service.", inputSchema: { workspace_id: workspace, input: objectInput } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, "prompts.manage", () => this.service.createPrompt(credential.adminId, input))));
    server.registerTool("prompt_create_version", { description: "Create a Prompt draft version.", inputSchema: { workspace_id: workspace, prompt_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, prompt_id, input }) => result(await this.service.withScope(credential, workspace_id, "prompts.manage", () => this.service.createPromptVersion(credential.adminId, prompt_id, input))));
    server.registerTool("prompt_update_draft", { description: "Update a Prompt draft version.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, version_id, input }) => result(await this.service.withScope(credential, workspace_id, "prompts.manage", () => this.service.updatePromptVersion(credential.adminId, version_id, input))));
    server.registerTool("prompt_publish", { description: "Publish a Prompt draft through the existing Prompt publication workflow.", inputSchema: { workspace_id: workspace, version_id: z.number().int().positive(), input: objectInput.optional() } }, async ({ workspace_id, version_id, input }) => result(await this.service.withScope(credential, workspace_id, "prompts.manage", () => this.service.publishPrompt(credential.adminId, version_id, input ?? {}))));
    server.registerTool("knowledge_bases_list", { description: "List knowledge-base metadata without document content or connection credentials.", inputSchema: { workspace_id: workspace } }, async ({ workspace_id }) => result(await this.service.withScope(credential, workspace_id, "knowledge.read", () => this.service.listKnowledgeBases())));
    server.registerTool("knowledge_base_get", { description: "Read a knowledge-base configuration summary.", inputSchema: { workspace_id: workspace, knowledge_base_id: z.number().int().positive() } }, async ({ workspace_id, knowledge_base_id }) => result(await this.service.withScope(credential, workspace_id, "knowledge.read", () => this.service.getKnowledgeBase(knowledge_base_id))));
    server.registerTool("knowledge_base_create", { description: "Create a knowledge base through the existing configuration service.", inputSchema: { workspace_id: workspace, input: objectInput } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, "knowledge.manage", () => this.service.createKnowledgeBase(credential.adminId, input))));
    server.registerTool("knowledge_base_update", { description: "Update knowledge-base metadata through the existing service.", inputSchema: { workspace_id: workspace, knowledge_base_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, knowledge_base_id, input }) => result(await this.service.withScope(credential, workspace_id, "knowledge.manage", () => this.service.updateKnowledgeBase(credential.adminId, knowledge_base_id, input))));
    server.registerTool("knowledge_base_archive", { description: "Archive a knowledge base.", inputSchema: { workspace_id: workspace, knowledge_base_id: z.number().int().positive() } }, async ({ workspace_id, knowledge_base_id }) => result(await this.service.withScope(credential, workspace_id, "knowledge.manage", () => this.service.archiveKnowledgeBase(credential.adminId, knowledge_base_id))));
    server.registerTool("knowledge_base_configure", { description: "Update knowledge-base index settings through the existing validation service.", inputSchema: { workspace_id: workspace, knowledge_base_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, knowledge_base_id, input }) => result(await this.service.withScope(credential, workspace_id, "knowledge.manage", () => this.service.configureKnowledgeBase(credential.adminId, knowledge_base_id, input))));
    server.registerTool("knowledge_base_build_index", { description: "Build and activate a knowledge-base index through the existing index service.", inputSchema: { workspace_id: workspace, knowledge_base_id: z.number().int().positive(), activate_on_ready: z.boolean().default(false) } }, async ({ workspace_id, knowledge_base_id, activate_on_ready }) => result(await this.service.withScope(credential, workspace_id, "knowledge.manage", () => this.service.buildKnowledgeIndex(credential.adminId, knowledge_base_id, activate_on_ready))));
    for (const [kind, scope, prefix] of [["llm", "models.manage", "llm_model"], ["embedding", "embeddings.manage", "embedding_model"]] as const) {
      server.registerTool(`${prefix}_create_plan`, { description: `Create a ${kind} model plan.`, inputSchema: { workspace_id: workspace, input: objectInput } }, async ({ workspace_id, input }) => result(await this.service.withScope(credential, workspace_id, scope, () => this.service.createModelPlan(credential.adminId, kind, input))));
      server.registerTool(`${prefix}_prepare_draft`, { description: `Prepare a ${kind} model plan draft.`, inputSchema: { workspace_id: workspace, plan_id: z.number().int().positive(), input: objectInput.optional() } }, async ({ workspace_id, plan_id, input }) => result(await this.service.withScope(credential, workspace_id, scope, () => this.service.prepareModelDraft(credential.adminId, kind, plan_id, input ?? {}))));
      server.registerTool(`${prefix}_update_draft`, { description: `Update a ${kind} model plan draft.`, inputSchema: { workspace_id: workspace, version_id: z.number().int().positive(), input: objectInput } }, async ({ workspace_id, version_id, input }) => result(await this.service.withScope(credential, workspace_id, scope, () => this.service.updateModelDraft(credential.adminId, kind, version_id, input))));
      server.registerTool(`${prefix}_test_and_publish`, { description: `Test and publish a ${kind} model plan using the existing validation workflow.`, inputSchema: { workspace_id: workspace, version_id: z.number().int().positive() } }, async ({ workspace_id, version_id }) => {
        const published = await this.service.withScope(credential, workspace_id, scope, () => this.service.testAndPublishModel(credential.adminId, kind, version_id));
        return result({ ok: published.ok, published: published.published });
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    await server.close();
  }
}

@Controller("admin/system-mcp")
@UseGuards(AdminAuthGuard, PermissionGuard)
export class SystemMcpAdminController {
  constructor(private readonly service: SystemMcpService) {}
  @Get("credentials") @RequirePermission("agent_config.read", "agent_config.manage")
  credentials(@Req() request: AdminRequest) { return this.service.listCredentials(request.admin!.id); }
  @Post("credentials") @RequirePermission("agent_config.manage")
  create(@Req() request: AdminRequest, @Body() body: unknown) { return this.service.createCredential(request.admin!.id, body); }
  @Patch("credentials/:id/scopes") @RequirePermission("agent_config.manage")
  updateScopes(@Req() request: AdminRequest, @Param("id", ParseIntPipe) id: number, @Body() body: unknown) { return this.service.updateCredentialScopes(request.admin!.id, id, body); }
  @Post("credentials/:id/revoke") @RequirePermission("agent_config.manage")
  revoke(@Req() request: AdminRequest, @Param("id", ParseIntPipe) id: number) { return this.service.revokeCredential(request.admin!.id, id); }
  @Get("recording-policy") @RequirePermission("agent_config.read", "agent_config.manage")
  policy(@Req() request: AdminRequest) { return this.service.getRecordingPolicy(request.admin!.id); }
  @Post("recording-policy") @RequirePermission("agent_config.manage")
  updatePolicy(@Req() request: AdminRequest, @Body() body: unknown) { return this.service.updateRecordingPolicy(request.admin!.id, body); }
}
