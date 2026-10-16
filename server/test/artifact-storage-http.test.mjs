import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { DatabaseService } from "../dist/database.service.js";
import { AppConfigService } from "../dist/config/config.service.js";
import { WorkspaceService } from "../dist/workspaces/workspace.service.js";
import { inWorkspace } from "../dist/workspaces/workspace-context.js";
import { IntegrationService } from "../dist/integrations/integration.service.js";
import { AdminAuthGuard } from "../dist/admin/admin-auth.guard.js";
import { PermissionGuard } from "../dist/admin/permission.guard.js";
import { AgentAccessGuard } from "../dist/integrations/integration.guards.js";
import { RequestContextMiddleware } from "../dist/security/request-context.middleware.js";
import { HttpExceptionFilter } from "../dist/security/http-exception.filter.js";
import { ExecutionArtifactService } from "../dist/artifacts/execution-artifact.service.js";
import {
  AdminArtifactController,
  AgentArtifactController,
} from "../dist/artifacts/artifact.controller.js";
import {
  FileOutputCollector,
  fileDescriptor,
} from "../dist/artifacts/file-output.js";
import { purgeUnavailableArtifacts } from "../dist/artifacts/retention.js";
import { ConversationService } from "../dist/chat/conversation.service.js";

test(
  "artifact HTTP + PostgreSQL: ownership, reader/purge permissions, immutable bytes, atomic Chat history, cancellation and disabled-workspace retention",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async () => {
    const root = new Client({ connectionString: process.env.DATABASE_URL }),
      schema = "artifact_http_" + randomUUID().replaceAll("-", "");
    let db, app;
    await root.connect();
    try {
      await root.query("BEGIN");
      await root.query(`CREATE SCHEMA ${schema}`);
      await root.query(`SET LOCAL search_path TO ${schema},public`);
      const directory = new URL("../migrations/", import.meta.url);
      for (const f of (await readdir(directory))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await root.query(
          (await readFile(new URL(f, directory), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      await root.query("COMMIT");
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set("options", `-csearch_path=${schema},public`);
      db = new DatabaseService({ databaseUrl: url.toString() });
      const actor = Number(
        (
          await db.platformQuery(
            "INSERT INTO admins(email,password_hash,display_name)VALUES('artifact-owner@fixture.invalid','fixture','owner')RETURNING id",
          )
        ).rows[0].id,
      );
      const reader = Number(
        (
          await db.platformQuery(
            "INSERT INTO admins(email,password_hash,display_name)VALUES('artifact-reader@fixture.invalid','fixture','reader')RETURNING id",
          )
        ).rows[0].id,
      );
      const workspaces = new WorkspaceService(db),
        a = await workspaces.create(actor, { name: "Artifact A" }),
        b = await workspaces.create(actor, { name: "Artifact B" });
      await workspaces.setMember(actor, a.id, {
        adminId: reader,
        role: "reader",
      });
      const config = {
        jwt: { issuer: "artifact-fixture", audience: "artifact-admin" },
        security: { allowedOrigins: ["https://shop.example"] },
      };
      const jwt = new JwtService({
        secret: randomUUID(),
        signOptions: {
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
          expiresIn: "10m",
        },
      });
      const access = new IntegrationService(db, jwt, config),
        artifacts = new ExecutionArtifactService(db, access);
      const context = new RequestContextMiddleware();
      class Fixture {}
      Module({
        controllers: [AdminArtifactController, AgentArtifactController],
        providers: [
          AdminAuthGuard,
          PermissionGuard,
          AgentAccessGuard,
          { provide: JwtService, useValue: jwt },
          { provide: AppConfigService, useValue: config },
          { provide: IntegrationService, useValue: access },
          { provide: ExecutionArtifactService, useValue: artifacts },
          {
            provide: DatabaseService,
            useValue: {
              db: db.db,
              query: db.query.bind(db),
              platformQuery: db.platformQuery.bind(db),
            },
          },
        ],
      })(Fixture);
      app = await NestFactory.create(Fixture, {
        logger: false,
        abortOnError: false,
      });
      app.setGlobalPrefix("api");
      app.use((q, r, n) => context.use(q, r, n));
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl(),
        ownerToken = await jwt.signAsync({
          sub: String(actor),
          sessionVersion: 0,
        }),
        readerToken = await jwt.signAsync({
          sub: String(reader),
          sessionVersion: 0,
        });
      const http = (
        path,
        { token = ownerToken, workspace = a.id, method = "GET" } = {},
      ) =>
        fetch(base + "/api" + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Workspace-ID": String(workspace),
          },
        });
      let agent,
        version,
        application,
        owner,
        identity,
        trace,
        run,
        files,
        output;
      await inWorkspace(a.id, async () => {
        agent = Number(
          (
            await db.query(
              "INSERT INTO agent_resources(kind,resource_key,name)VALUES('agent','file_owner','File owner')RETURNING id::int",
            )
          ).rows[0].id,
        );
        version = Number(
          (
            await db.query(
              "INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,1,'published','{\"fileOutputs\":{\"enabled\":true}}')RETURNING id::int",
              [agent],
            )
          ).rows[0].id,
        );
        await db.query(
          "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
          [agent, version],
        );
        application = await access.save(actor, {
          agentId: agent,
          name: "Files app",
          enabled: true,
          apiEnabled: true,
          websiteEnabled: true,
          allowedOrigins: ["https://shop.example"],
          scopes: ["chat:write", "conversations:read"],
          requestsPerMinute: 1000,
          concurrency: 10,
          dailyRequests: 1000,
        });
        const key = await access.createKey(actor, application.id, {
          name: "Fixture key",
          scopes: application.scopes,
        });
        application.token = key.apiKey;
        identity = await access.authenticate({
          headers: { authorization: `Bearer ${key.apiKey}` },
          get: () => undefined,
        });
        owner = await access.platformOwner(identity, "alice");
        trace = randomUUID();
        run = await access.admitRun(
          identity,
          owner,
          "a".repeat(64),
          "file-fixture",
        );
        await db.query("UPDATE integration_calls SET trace_id=$2 WHERE id=$1", [
          run.callId,
          trace,
        ]);
        await db.query(
          "INSERT INTO chat_traces(id,application_id,question,context_snapshot,status,final_answer,duration_ms)VALUES($1,$2,'Fixture',$3,'completed','Done',1)",
          [
            trace,
            application.id,
            JSON.stringify({
              agentComposition: { agentId: agent, entryVersionId: version },
            }),
          ],
        );
        const collector = new FileOutputCollector(true);
        output = collector.capture(
          version,
          true,
          ["/workspace/outputs/report.md"],
          {
            "/workspace/outputs/report.md": { content: "PRIVATE_STORED_FILE" },
          },
        );
        files = collector.forResult(output);
        await db.transaction((client) =>
          artifacts.save(
            client,
            {
              source: "generic_run",
              traceId: trace,
              runId: run.callId,
              entryVersionId: version,
              applicationId: application.id,
              visitorSessionId: owner,
            },
            files,
            output,
          ),
        );
        assert.equal(
          (await artifacts.list(trace))[0].available,
          false,
          "unsettled integration result cannot expose a file",
        );
        await access.finish(run.callId, { runId: run.callId, traceId: trace });
      });
      const file = files[0],
        adminPath = `/admin/executions/${trace}/artifacts`;
      const listing = await http(adminPath, { token: readerToken });
      assert.equal(listing.status, 200);
      const meta = await listing.json();
      assert.equal(meta[0].available, true);
      assert.doesNotMatch(JSON.stringify(meta), /PRIVATE_STORED_FILE|content/);
      const download = await http(adminPath + "/" + file.id, {
        token: readerToken,
      });
      assert.equal(download.status, 200);
      assert.equal(await download.text(), "PRIVATE_STORED_FILE");
      assert.match(download.headers.get("content-security-policy"), /sandbox/);
      assert.match(download.headers.get("cache-control"), /no-store/);
      assert.equal(
        (
          await http(adminPath + "/" + file.id, {
            token: readerToken,
            method: "DELETE",
          })
        ).status,
        403,
      );
      assert.equal((await http(adminPath, { workspace: b.id })).status, 404);
      assert.equal(
        (await http(adminPath + "/" + file.id, { workspace: b.id })).status,
        404,
      );
      const appRead = await http(
        `/v1/agent/${agent}/artifacts/${file.id}?userId=alice`,
        { token: application.token },
      );
      assert.equal(appRead.status, 200);
      assert.equal(await appRead.text(), "PRIVATE_STORED_FILE");
      assert.equal(
        (
          await http(`/v1/agent/${agent}/artifacts/${file.id}?userId=bob`, {
            token: application.token,
          })
        ).status,
        404,
      );
      await inWorkspace(a.id, async () => {
        await assert.rejects(
          db.query("UPDATE execution_artifacts SET content=$2 WHERE id=$1", [
            file.id,
            Buffer.from("other"),
          ]),
          /immutable/,
        );
        await assert.rejects(
          db.query(
            "UPDATE execution_artifacts SET expires_at=expires_at+interval '1 day' WHERE id=$1",
            [file.id],
          ),
          /immutable/,
        );
        await assert.rejects(
          db.query(
            "ALTER TABLE execution_artifacts DISABLE TRIGGER execution_artifact_immutable",
          ),
          /owner|permission/i,
        );
        await assert.rejects(
          artifacts.save(
            { query: db.query.bind(db) },
            {
              source: "generic_run",
              traceId: trace,
              runId: run.callId,
              entryVersionId: version,
              applicationId: application.id,
              visitorSessionId: owner,
            },
            [{ ...file, id: randomUUID(), content: "tampered" }],
            [fileDescriptor({ ...file, id: randomUUID() })],
          ),
        );
      });
      assert.equal(
        (await http(adminPath + "/" + file.id, { method: "DELETE" })).status,
        200,
      );
      assert.equal((await http(adminPath + "/" + file.id)).status, 404);
      await inWorkspace(a.id, async () => {
        const purged = (
          await db.query(
            "SELECT content,purged_at FROM execution_artifacts WHERE id=$1",
            [file.id],
          )
        ).rows[0];
        assert.equal(purged.content, null);
        assert.ok(purged.purged_at);
        assert.equal(
          (
            await db.query(
              "SELECT 1 FROM audit_logs WHERE action='execution_artifact.purged'",
            )
          ).rowCount,
          1,
        );
        const conversations = new ConversationService(
          db,
          {},
          { model: "fixture" },
          undefined,
          undefined,
          undefined,
          access,
          undefined,
          undefined,
          undefined,
          artifacts,
        );
        const conversation = (
          await db.query(
            "INSERT INTO conversations(id,visitor_session_id,application_id)VALUES($1,$2,$3)RETURNING id",
            [randomUUID(), owner, application.id],
          )
        ).rows[0];
        const chatRun = randomUUID(),
          chatTrace = randomUUID();
        await db.query(
          "INSERT INTO conversation_runs(id,conversation_id,client_request_id,question,status,expires_at)VALUES($1,$2,'chat-file','Chat file','running',now()+interval '5 minutes')",
          [chatRun, conversation.id],
        );
        const collector = new FileOutputCollector(true),
          chatOutput = collector.capture(
            version,
            true,
            ["/workspace/outputs/chat.md"],
            { "/workspace/outputs/chat.md": { content: "PRIVATE_CHAT_FILE" } },
          ),
          chatFiles = collector.forResult(chatOutput);
        const answer = {
          traceId: chatTrace,
          result: {
            answer: "Chat file ready",
            refused: false,
            citations: [],
            artifacts: chatOutput,
          },
          contextSnapshot: {
            agentComposition: { agentId: agent, entryVersionId: version },
          },
          rawModelOutput: null,
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          fileOutputs: chatFiles,
        };
        await conversations.saveResult(
          conversation.id,
          "Chat file",
          answer,
          1,
          chatRun,
        );
        const saved = (
          await db.query(
            "SELECT assistant_message_id FROM conversation_runs WHERE id=$1",
            [chatRun],
          )
        ).rows[0];
        const replay = await conversations.resultForRun({
          id: chatRun,
          conversationId: conversation.id,
          assistantMessageId: saved.assistant_message_id,
        });
        assert.deepEqual(replay.artifacts, chatOutput);
        const read = await artifacts.downloadForApp(
          identity,
          agent,
          chatFiles[0].id,
          "alice",
        );
        assert.equal(read.content.toString(), "PRIVATE_CHAT_FILE");
        assert.doesNotMatch(
          JSON.stringify(
            (
              await db.query(
                "SELECT context_snapshot FROM chat_traces WHERE id=$1",
                [chatTrace],
              )
            ).rows,
          ),
          /PRIVATE_CHAT_FILE/,
        );
        // Cancellation before commit rolls back Trace, answer, file and file audit.
        const cancelledRun = randomUUID(),
          cancelledTrace = randomUUID(),
          signal = new AbortController();
        await db.query(
          "INSERT INTO conversation_runs(id,conversation_id,client_request_id,question,status,expires_at)VALUES($1,$2,'cancel-file','Cancelled file','running',now()+interval '5 minutes')",
          [cancelledRun, conversation.id],
        );
        const originalSave = artifacts.save.bind(artifacts);
        artifacts.save = async (...args) => {
          await originalSave(...args);
          signal.abort(new Error("cancelled"));
        };
        const cancelledCollector = new FileOutputCollector(true),
          cancelledOutput = cancelledCollector.capture(
            version,
            true,
            ["/workspace/outputs/cancel.md"],
            { "/workspace/outputs/cancel.md": { content: "NO_COMMIT" } },
          ),
          cancelledFiles = cancelledCollector.forResult(cancelledOutput);
        try {
          await assert.rejects(
            conversations.saveResult(
              conversation.id,
              "Cancelled",
              {
                ...answer,
                traceId: cancelledTrace,
                result: { ...answer.result, artifacts: cancelledOutput },
                fileOutputs: cancelledFiles,
              },
              1,
              cancelledRun,
              signal.signal,
            ),
            /cancelled/,
          );
        } finally {
          artifacts.save = originalSave;
        }
        assert.equal(
          (
            await db.query("SELECT 1 FROM execution_artifacts WHERE id=$1", [
              cancelledFiles[0].id,
            ])
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await db.query("SELECT 1 FROM chat_traces WHERE id=$1", [
              cancelledTrace,
            ])
          ).rowCount,
          0,
        );
        // Removing the conversation also removes its file bytes and metadata.
        await conversations.remove(owner, conversation.id);
        assert.equal(
          (
            await db.query("SELECT 1 FROM execution_artifacts WHERE id=$1", [
              chatFiles[0].id,
            ])
          ).rowCount,
          0,
        );
        // Simulate old files by inserting historical timestamps, not weakening the immutable trigger.
        const oldRun = await access.admitRun(
            identity,
            owner,
            "b".repeat(64),
            "old-files",
          ),
          oldTrace = randomUUID();
        await db.query("UPDATE integration_calls SET trace_id=$2 WHERE id=$1", [
          oldRun.callId,
          oldTrace,
        ]);
        await db.query(
          "INSERT INTO chat_traces(id,application_id,question,context_snapshot,status,duration_ms)VALUES($1,$2,'Old files',$3,'completed',1)",
          [
            oldTrace,
            application.id,
            JSON.stringify({ agentComposition: { entryVersionId: version } }),
          ],
        );
        for (let i = 0; i < 3; i++)
          await db.query(
            "INSERT INTO execution_artifacts(id,trace_id,run_id,source,entry_version_id,producer_version_id,application_id,visitor_session_id,filename,byte_size,sha256,content,created_at,expires_at)VALUES($1,$2,$3,'generic_run',$4,$4,$5,$6,'old.txt',3,$7,$8,now()-interval '8 days',now()-interval '1 day')",
            [
              randomUUID(),
              oldTrace,
              oldRun.callId,
              version,
              application.id,
              owner,
              createHash("sha256").update("old").digest("hex"),
              Buffer.from("old"),
            ],
          );
        await access.finish(oldRun.callId, {
          runId: oldRun.callId,
          traceId: oldTrace,
        });
      });
      await workspaces.status(actor, a.id, false);
      const maintenanceUrl = new URL(process.env.DATABASE_URL);
      maintenanceUrl.searchParams.set(
        "options",
        `-csearch_path=${schema},public`,
      );
      const maintenance = new DatabaseService({
        databaseUrl: maintenanceUrl.toString(),
      });
      try {
        assert.equal(
          (
            await maintenance.query(
              "SELECT purge_unavailable_execution_artifacts($1) AS purged",
              [1],
            )
          ).rows[0].purged,
          1,
        );
        assert.equal(await purgeUnavailableArtifacts(maintenance), 2);
        assert.equal(await purgeUnavailableArtifacts(maintenance), 0);
        const remaining = (
          await maintenance.platformQuery(
            "SELECT 1 FROM execution_artifacts WHERE content IS NOT NULL",
          )
        ).rowCount;
        assert.equal(remaining, 0);
        assert.equal(
          (
            await maintenance.platformQuery(
              "SELECT 1 FROM execution_artifact_events WHERE action='retention_purged'",
            )
          ).rowCount,
          3,
        );
      } finally {
        await maintenance.onModuleDestroy();
      }
    } finally {
      if (app) await app.close();
      if (db) await db.onModuleDestroy();
      await root.query("ROLLBACK");
      await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await root.end();
    }
  },
);
