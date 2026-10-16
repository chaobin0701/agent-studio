import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { JwtService } from "@nestjs/jwt";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DatabaseService } from "../dist/database.service.js";
import { AppConfigService } from "../dist/config/config.service.js";
import { AdminAuthGuard } from "../dist/admin/admin-auth.guard.js";
import { PermissionGuard } from "../dist/admin/permission.guard.js";
import { RequestContextMiddleware } from "../dist/security/request-context.middleware.js";
import { HttpExceptionFilter } from "../dist/security/http-exception.filter.js";
import { SecurityRateLimitService } from "../dist/security/security-rate-limit.service.js";
import { inWorkspace } from "../dist/workspaces/workspace-context.js";
import { IntegrationService } from "../dist/integrations/integration.service.js";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { agentSchema } from "../dist/agent-management/resource.types.js";
import { AgentRunService } from "../dist/executions/agent-run.service.js";
import { ExecutionArtifactService } from "../dist/artifacts/execution-artifact.service.js";
import { ChatbotService } from "../dist/chatbot/chatbot.service.js";
import { ChatbotAttachmentService } from "../dist/chatbot/chatbot-attachment.service.js";
import sharp from "sharp";
import {
  AdminChatbotController,
  WebsiteChatbotController,
} from "../dist/chatbot/chatbot.controller.js";
import { ConversationService } from "../dist/chat/conversation.service.js";
import { LegacyWebsiteGuard } from "../dist/integrations/integration.guards.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import { reserveModelCall } from "../dist/chat/model-call-accounting.js";
import { z } from "zod";

test(
  "Chatbot: real administrator ledger, private sessions, idempotency, history, reconnect, stop and visitor ownership",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () =>
    inWorkspace(1, async () => {
      const root = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const schema = "chatbot_" + randomUUID().replaceAll("-", "");
      let db, app, chat;
      await root.connect();
      try {
        await root.query(`CREATE SCHEMA ${schema}`);
        const connection = new URL(process.env.TEST_DATABASE_URL);
        connection.searchParams.set(
          "options",
          `-csearch_path=${schema},public`,
        );
        db = new DatabaseService({ databaseUrl: connection.toString() });
        const dir = new URL("../migrations/", import.meta.url);
        for (const f of (await readdir(dir))
          .filter((f) => f.endsWith(".sql"))
          .sort())
          await db.platformQuery(
            (await readFile(new URL(f, dir), "utf8")).split(
              "-- Down Migration",
            )[0],
          );
        await db.platformQuery(
          `INSERT INTO admins(id,email,password_hash,display_name) OVERRIDING SYSTEM VALUE VALUES(1,'chat-a@fixture.invalid','fixture','A'),(2,'chat-b@fixture.invalid','fixture','B'),(3,'chat-reader@fixture.invalid','fixture','reader');INSERT INTO workspace_members(workspace_id,admin_id,role,permission_codes)VALUES(1,1,'owner','{}'),(1,2,'custom','{agent_chat.use}'),(1,3,'reader','{}')`,
        );
        const prompt = (
          await db.query(
            `WITH p AS(INSERT INTO prompt_resources(prompt_key,name,prompt_type)VALUES('chat.prompt','Chat prompt','system')RETURNING id)INSERT INTO prompt_versions(resource_id,version,status,template)SELECT id,1,'published','General assistance'FROM p RETURNING id::int`,
          )
        ).rows[0].id;
        await db.query(
          "INSERT INTO model_accounts(kind,name,platform_key,base_url,api_key_ciphertext) VALUES('llm','Fixture','custom','https://fixture.invalid','fixture');INSERT INTO model_deployments(kind,account_id,name,config) VALUES('llm',1,'Fixture','{}')",
        );
        const model = (
          await db.query(
            `WITH p AS(INSERT INTO model_plans(kind,name)VALUES('llm','Chat model')RETURNING id)INSERT INTO model_plan_versions(plan_id,version,status,config)SELECT id,1,'published',$1 FROM p RETURNING id::int`,
            [
              JSON.stringify({
                deployments: [
                  {
                    id: 1,
                    accountId: 1,
                    name: "Image fixture",
                    baseUrl: "https://fixture.invalid",
                    config: {
                      provider: "openai-compatible",
                      model: "fixture",
                      timeoutMs: 1000,
                      contextWindowTokens: 32000,
                      maxOutputTokens: 1200,
                      maxRetries: 0,
                      streamUsage: true,
                      supportsImageInput: true,
                    },
                  },
                ],
              }),
            ],
          )
        ).rows[0].id;
        const agent = (
          await db.query(
            `INSERT INTO agent_resources(kind,resource_key,name)VALUES('agent','chatbot','Chatbot fixture')RETURNING id::int`,
          )
        ).rows[0].id;
        const spec = agentSchema.parse({
          responsibility: "General assistant",
          promptVersionId: prompt,
          modelPlanVersionId: model,
          toolVersionIds: [],
          skillVersionIds: [],
          knowledgeBaseIds: [],
          runtime: {},
        });
        const version = (
          await db.query(
            `INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,1,'published',$2)RETURNING id::int`,
            [agent, JSON.stringify(spec)],
          )
        ).rows[0].id;
        await db.query(
          "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
          [agent, version],
        );
        await db.query(
          "UPDATE integration_apps SET agent_id=$1 WHERE is_internal",
          [agent],
        );
        const config = {
          agent: DEFAULT_AGENT_CONFIGURATION,
          jwt: { issuer: "chat-fixture", audience: "chat-admin" },
          security: { allowedOrigins: ["https://site.example"] },
        };
        const jwt = new JwtService({
          secret: randomUUID(),
          signOptions: {
            issuer: config.jwt.issuer,
            audience: config.jwt.audience,
            expiresIn: 300,
          },
        });
        const access = new IntegrationService(db, jwt, config);
        const tools = new ToolRegistry();
        for (const name of ["search_knowledge", "load_skill"])
          tools.register({
            name,
            description: name,
            inputSchema: z.object({}),
            execute: async () => ({ success: true, content: "Fixture" }),
          });
        const management = new AgentManagementService(
          db,
          config,
          tools,
          new SkillRegistry(),
          { snapshot: async () => ({ environment: "dev", prompts: {} }) },
          {},
        );
        const seen = [],
          contexts = [];
        const execution = {
          async runTask(composition, task, context, callbacks) {
            seen.push(task);
            contexts.push(context);
            const lease = await reserveModelCall(
              {
                model: "fixture",
                messages: [{ role: "user", content: task.task }],
                maxTokens: 20,
              },
              "planner",
            );
            try {
              callbacks.onAnswerDelta?.("partial");
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(
                  resolve,
                  task.task === "slow" ? 1500 : 35,
                );
                const abort = () => {
                  clearTimeout(timeout);
                  reject(context.signal.reason);
                };
                context.signal.addEventListener("abort", abort, { once: true });
              });
              if (task.task === "fail")
                throw new Error("PRIVATE_PROVIDER_SECRET");
              return {
                output: {
                  status: "completed",
                  answer: "Answer: " + task.task,
                  structured:{summary:task.task},
                  references: [],
                  artifacts: [],
                  usage: {},
                },
                contextSnapshot: {
                  executionInput: task,
                  agentComposition: {
                    entryVersionId: composition.entryVersionId,
                  },
                },
                rawModelOutput: null,
              };
            } finally {
              await lease?.settle({
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
              });
            }
          },
        };
        const artifacts = new ExecutionArtifactService(db, access);
        const tracer = {
          span: async (_name, _kind, _meta, callback) => callback({}),
          link: () => ({}),
        };
        const runs = new AgentRunService(
          db,
          management,
          execution,
          access,
          tracer,
          artifacts,
        );
        chat = new ChatbotService(
          db,
          management,
          runs,
          access,
          new SecurityRateLimitService(config),
          artifacts,
          new ChatbotAttachmentService(db),
        );
        const conversations = new ConversationService(
          db,
          {},
          {},
          undefined,
          config,
          undefined,
          access,
        );
        const context = new RequestContextMiddleware();
        class Fixture {}
        Module({
          controllers: [AdminChatbotController, WebsiteChatbotController],
          providers: [
            AdminAuthGuard,
            PermissionGuard,
            LegacyWebsiteGuard,
            { provide: DatabaseService, useValue: db },
            { provide: AppConfigService, useValue: config },
            { provide: JwtService, useValue: jwt },
            { provide: IntegrationService, useValue: access },
            { provide: ChatbotService, useValue: chat },
            { provide: ConversationService, useValue: conversations },
          ],
        })(Fixture);
        app = await NestFactory.create(Fixture, { logger: false });
        app.setGlobalPrefix("api");
        app.use((r, s, n) => context.use(r, s, n));
        const filter = new HttpExceptionFilter();
        app.useGlobalFilters({
          catch(error, host) {
            if (!error.getStatus) console.error("Fixture error:", error);
            return filter.catch(error, host);
          },
        });
        await app.listen(0, "127.0.0.1");
        const base =
          "http://127.0.0.1:" + app.getHttpServer().address().port + "/api";
        const admin = async (
          path,
          body,
          method = body ? "POST" : "GET",
          actor = 1,
        ) =>
          fetch(base + "/admin/chatbot" + path, {
            method,
            headers: {
              authorization:
                "Bearer " +
                (await jwt.signAsync({
                  sub: String(actor),
                  sessionVersion: 0,
                })),
              "x-workspace-id": "1",
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        const json = async (response) => {
          assert.ok(
            response.ok,
            `${response.status}: ${await response.clone().text()}`,
          );
          return response.json();
        };
        const wait = async (id, runId) => {
          for (let i = 0; i < 100; i++) {
            const turn = await json(
              await admin(`/sessions/${id}/runs/${runId}`),
            );
            if (turn.status !== "running") return turn;
            await new Promise((r) => setTimeout(r, 30));
          }
          throw Error("Timed out");
        };
        assert.equal(
          (await admin("/options", undefined, "GET", 3)).status,
          403,
        );
        const options = await json(await admin("/options"));
        assert.equal(options.agents[0].id, agent);
        assert.equal(options.agents[0].supportsImages, true);
        assert.equal(options.agents[0].modelPlanVersionId, model);
        assert.equal(options.agents[0].imageInputReason, null);
        // A live deployment flag must not override a pinned, immutable plan snapshot.
        await db.query("UPDATE model_deployments SET config='{\"supportsImageInput\":true}' WHERE id=1");
        const stalePlan=(await db.query("INSERT INTO model_plan_versions(plan_id,version,status,config) SELECT plan_id,2,'published',jsonb_set(config,'{deployments,0,config,supportsImageInput}','false') FROM model_plan_versions WHERE id=$1 RETURNING id::int",[model])).rows[0].id;
        const staleAgent=(await db.query("INSERT INTO agent_resource_versions(resource_id,version,status,config) VALUES($1,2,'published',$2) RETURNING id::int",[agent,JSON.stringify({...spec,modelPlanVersionId:stalePlan})])).rows[0].id;
        await db.query('UPDATE agent_resources SET current_version_id=$2 WHERE id=$1',[agent,staleAgent]);
        const stale=await json(await admin('/options'));
        assert.equal(stale.agents[0].supportsImages,false);
        assert.equal(stale.agents[0].imageConfigOutdated,true);
        assert.match(stale.agents[0].imageInputReason,/同步并发布模型方案/);
        await db.query('UPDATE agent_resources SET current_version_id=$2 WHERE id=$1',[agent,version]);
        const session = await json(
          await admin("/sessions", { agentId: agent }),
        );
        assert.equal(
          (await admin(`/sessions/${session.id}`, undefined, "GET", 2)).status,
          404,
        );
        const requestId = randomUUID();
        const first = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId,
            message: "hello",
            stream: false,
          }),
        );
        const completed = await wait(session.id, first.id);
        assert.equal(completed.status, "completed");
        assert.deepEqual((await json(await admin(`/sessions/${session.id}`))).messages.at(-1).structured,{summary:"hello"});
        assert.equal(completed.response.usage.totalTokens, 5);
        const owner = (
          await db.query(
            "SELECT app_id,visitor_session_id,admin_actor_id::int,entry_agent_id::int FROM integration_calls WHERE id=$1",
            [first.id],
          )
        ).rows[0];
        assert.deepEqual(owner, {
          app_id: null,
          visitor_session_id: null,
          admin_actor_id: 1,
          entry_agent_id: agent,
        });
        assert.equal(
          (
            await db.query(
              "SELECT app_id FROM integration_model_calls WHERE call_id=$1",
              [first.id],
            )
          ).rows[0].app_id,
          null,
        );
        const replay = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId,
            message: "hello",
            stream: false,
          }),
        );
        assert.equal(replay.id, first.id);
        assert.equal(seen.length, 1);
        assert.equal(
          (
            await admin(`/sessions/${session.id}/messages`, {
              requestId,
              message: "different",
              stream: false,
            })
          ).status,
          409,
        );
        const second = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId: randomUUID(),
            message: "follow up",
            stream: false,
          }),
        );
        await wait(session.id, second.id);
        assert.deepEqual(
          seen[1].messages.map((m) => m.content),
          ["hello", "Answer: hello"],
        );
        await json(
          await admin(
            `/sessions/${session.id}`,
            { title: "Renamed session" },
            "PATCH",
          ),
        );
        assert.equal(
          (await json(await admin("/sessions?q=Renamed"))).length,
          1,
        );
        const slow = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId: randomUUID(),
            message: "slow",
            stream: false,
          }),
        );
        const events = await admin(
          `/sessions/${session.id}/runs/${slow.id}/events`,
        );
        const reader = events.body.getReader();
        assert.match(
          new TextDecoder().decode((await reader.read()).value),
          /run_started/,
        );
        await reader.cancel();
        const restored = await wait(session.id, slow.id);
        assert.equal(restored.status, "completed");
        assert.equal(seen.length, 3);
        const stop = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId: randomUUID(),
            message: "slow",
            stream: false,
          }),
        );
        assert.equal(
          (
            await admin(`/sessions/${session.id}/messages`, {
              requestId: randomUUID(),
              message: "parallel",
              stream: false,
            })
          ).status,
          409,
        );
        await json(
          await admin(`/sessions/${session.id}/runs/${stop.id}/cancel`, {}),
        );
        assert.equal((await wait(session.id, stop.id)).status, "cancelled");
        assert.equal(
          (await json(await admin(`/sessions/${session.id}`))).messages.length,
          8,
        );
        const upload = async (name, bytes, actor = 1) => {
          const form = new FormData();
          form.append("file", new Blob([bytes]), name);
          return fetch(
            base + `/admin/chatbot/sessions/${session.id}/attachments`,
            {
              method: "POST",
              headers: {
                authorization:
                  "Bearer " +
                  (await jwt.signAsync({
                    sub: String(actor),
                    sessionVersion: 0,
                  })),
                "x-workspace-id": "1",
              },
              body: form,
            },
          );
        };
        assert.equal(
          (await upload("private.md", Buffer.from("# private"), 2)).status,
          404,
        );
        const document = await json(
          await upload(
            "notes.md",
            Buffer.from("# Notes\n\nCONVERSATION_ONLY_TEXT"),
          ),
        );
        assert.equal(document.status, "ready");
        const invalid = await json(
          await upload("invalid.pdf", Buffer.from("not a PDF")),
        );
        assert.equal(invalid.status, "failed");
        assert.ok(invalid.error);
        const imageBytes = await sharp({
          create: { width: 16, height: 16, channels: 3, background: "red" },
        })
          .png()
          .toBuffer();
        const image = await json(await upload("photo.png", imageBytes));
        assert.equal(image.status, "ready");
        assert.equal(image.mimeType, "image/jpeg");
        assert.equal(
          (
            await admin(
              `/sessions/${session.id}/attachments/${image.id}`,
              undefined,
              "GET",
              2,
            )
          ).status,
          404,
        );
        const withFiles = await json(
          await admin(`/sessions/${session.id}/messages`, {
            requestId: randomUUID(),
            message: "files",
            attachmentIds: [document.id, image.id],
            stream: false,
          }),
        );
        assert.equal(
          (await wait(session.id, withFiles.id)).status,
          "completed",
        );
        assert.match(
          contexts.at(-1).contextFiles[0].content,
          /CONVERSATION_ONLY_TEXT/,
        );
        assert.equal(contexts.at(-1).images.length, 1);
        const trace = (
          await db.query(
            "SELECT context_snapshot FROM chat_traces WHERE id=$1",
            [
              (await chat.turn({ adminId: 1 }, session.id, withFiles.id))
                .traceId,
            ],
          )
        ).rows[0];
        assert.ok(!JSON.stringify(trace).includes("CONVERSATION_ONLY_TEXT"));
        assert.ok(
          !JSON.stringify(trace).includes(imageBytes.toString("base64")),
        );
        assert.equal(
          (await json(await admin(`/sessions/${session.id}`))).messages.at(-2)
            .attachments.length,
          2,
        );
        assert.equal(
          (await db.query("SELECT count(*)::int AS n FROM documents")).rows[0]
            .n,
          0,
        );
        const otherSession = await json(
          await admin("/sessions", { agentId: agent }),
        );
        assert.equal(
          (
            await admin(`/sessions/${otherSession.id}/messages`, {
              requestId: randomUUID(),
              message: "forged attachment",
              attachmentIds: [document.id],
              stream: false,
            })
          ).status,
          400,
        );
        await json(await admin(`/sessions/${session.id}`, undefined, "DELETE"));
        assert.equal((await admin(`/sessions/${session.id}`)).status, 404);
        assert.equal(
          (await admin(`/sessions/${session.id}/attachments/${document.id}`))
            .status,
          404,
        );
        assert.equal(
          (
        await db.query(
              "SELECT purge_unavailable_chatbot_attachments(100) AS n",
            )
          ).rows[0].n,
          2,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM chatbot_attachments WHERE session_id=$1 AND content IS NOT NULL",
              [session.id],
            )
          ).rows[0].n,
          0,
        );
        // Website fallback reuses an actual server-issued HttpOnly visitor Cookie.
        await db.query(
          "UPDATE integration_apps SET allowed_origins=ARRAY['https://site.example'],website_enabled=true WHERE is_internal",
        );
        const site = (path, body, cookie) =>
          fetch(base + "/chat/bot" + path, {
            method: body ? "POST" : "GET",
            headers: {
              origin: "https://site.example",
              ...(cookie ? { cookie } : {}),
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        const start = await site("/options");
        assert.equal(start.status, 200);
        const cookie = start.headers.get("set-cookie").split(";")[0];
        const external = await json(
          await site("/sessions", { agentId: agent }, cookie),
        );
        assert.equal((await site(`/sessions/${external.id}`)).status, 404);
        assert.equal((await admin(`/sessions/${external.id}`)).status, 404);
        assert.equal(
          (
            await json(
              await site(`/sessions/${external.id}`, undefined, cookie),
            )
          ).session.id,
          external.id,
        );
        // DB reference/immutable guards also reject programmer errors below HTTP.
        await assert.rejects(
          db.query("UPDATE chatbot_sessions SET admin_actor_id=2 WHERE id=$1", [
            session.id,
          ]),
          (e) => e.code === "23514",
        );
        await assert.rejects(
          db.query(
            "UPDATE integration_calls SET admin_actor_id=2 WHERE id=$1",
            [first.id],
          ),
          (e) => e.code === "23514",
        );
        const appId = (
          await db.query("SELECT id FROM integration_apps WHERE is_internal")
        ).rows[0].id;
        await assert.rejects(
          db.query(
            "UPDATE integration_model_calls SET app_id=$2 WHERE call_id=$1",
            [first.id, appId],
          ),
          (e) => ["23514", "23503"].includes(e.code),
        );
      } finally {
        try {
          await chat?.onApplicationShutdown();
          if (app) await app.close();
          else await db?.onModuleDestroy();
        } finally {
          await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          await root.end();
        }
      }
    }),
);
