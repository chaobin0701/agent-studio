import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { ToolManagementService } from "../dist/tool-management/tool-management.service.js";
import { SecretBox } from "../dist/security/secret-box.js";
import { inWorkspace } from "../dist/workspaces/workspace-context.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";

test(
  "PostgreSQL: external credentials, immutable MCP versions, import drafts and runtime workspace isolation",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async (t) => {
    const prior = process.env.AGENT_TOOL_ALLOWED_HOSTS;
    process.env.AGENT_TOOL_ALLOWED_HOSTS = "127.0.0.1";
    let realCalls = 0;
    const fixture = createServer(async (req, res) => {
      if (req.url === "/http") {
        realCalls++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: { id: 7 } }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const server = new McpServer({ name: "fixture", version: "1.0.0" });
      server.registerTool(
        "echo",
        { description: "echo", inputSchema: { text: z.string() } },
        async ({ text }) => {
          realCalls++;
          return { content: [{ type: "text", text }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const parts = [];
      for await (const part of req) parts.push(part);
      await transport.handleRequest(
        req,
        res,
        JSON.parse(Buffer.concat(parts).toString()),
      );
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = `http://127.0.0.1:${fixture.address().port}`;
    t.after(async () => {
      if (prior === undefined) delete process.env.AGENT_TOOL_ALLOWED_HOSTS;
      else process.env.AGENT_TOOL_ALLOWED_HOSTS = prior;
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    });
    const client = new Client({
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT ?? 5433),
      user: process.env.POSTGRES_USER ?? "grounded",
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB ?? "agent_studio",
    });
    await client.connect();
    const schema = "external_tools_" + randomUUID().replaceAll("-", "");
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}",public`);
      const dir = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .filter((name) => name.endsWith(".sql"))
        .sort())
        await client.query(
          (await readFile(new URL(file, dir), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      const actor = (
        await client.query(
          "INSERT INTO admins(username,password_hash,display_name)VALUES('external_fixture','fixture','fixture')RETURNING id::int",
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO workspace_members(workspace_id,admin_id,role)VALUES(1,$1,'owner')",
        [actor],
      );
      const query = (sql, args) => client.query(sql, args);
      const database = {
        query,
        platformQuery: query,
        transaction: async (work) => {
          await client.query("SAVEPOINT tool_call");
          try {
            const result = await work({ query });
            await client.query("RELEASE SAVEPOINT tool_call");
            return result;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT tool_call");
            throw error;
          }
        },
      };
      const secretBox = new SecretBox({
        modelConfigEncryptionKey: "fixture-external-tools-key",
        jwt: { secret: "fixture" },
      });
      const service = new ToolManagementService(database, secretBox);
      const credential = await service.createCredential(actor, {
        name: "fixture auth",
        kind: "bearer",
        secret: "private-fixture-token",
      });
      assert.equal(
        (await service.credential(credential.id)).secret,
        "private-fixture-token",
      );
      assert.equal(
        JSON.stringify(await service.credentials()).includes(
          "private-fixture-token",
        ),
        false,
      );
      const stored = (
        await client.query(
          "SELECT encrypted_secret FROM tool_credentials WHERE id=$1",
          [credential.id],
        )
      ).rows[0].encrypted_secret;
      assert.notEqual(stored, "private-fixture-token");
      const created = await service.createServer(actor, {
        key: "fixture_service",
        name: "Fixture service",
        config: {
          url: address + "/mcp",
          credentialId: credential.id,
          timeoutMs: 3000,
        },
      });
      let detail = await service.server(created.id);
      assert.equal(detail.versions.length, 1);
      const first = detail.versions[0];
      assert.equal(
        (await service.probe(actor, created.id, { versionId: first.id })).ok,
        true,
      );
      assert.equal(
        (await service.server(created.id)).versions.length,
        1,
        "connection tests do not save or authorize tools",
      );
      const discovered = await service.probe(
        actor,
        created.id,
        { versionId: first.id },
        true,
      );
      assert.equal(discovered.ok, true);
      const imported = await service.importTool(actor, created.id, {
        versionId: discovered.id,
        toolName: "echo",
      });
      const version = (
        await client.query(
          "SELECT config,status FROM agent_resource_versions WHERE id=$1",
          [imported.versionId],
        )
      ).rows[0];
      assert.equal(version.status, "draft");
      assert.equal(version.config.requiresApproval, true);
      assert.equal(version.config.maxRetries, 0);
      assert.equal(version.config.readOnly, false);
      assert.equal(version.config.mcpVersionId, discovered.id);
      const agents = new AgentManagementService(
        database,
        { agent: DEFAULT_AGENT_CONFIGURATION },
        new ToolRegistry(),
        new SkillRegistry(),
        {},
        {},
        service,
      );
      assert.equal(
        (
          await agents.test(actor, imported.versionId, {
            input: { text: "integration" },
            execute: true,
          })
        ).errorCode,
        "tool_approval_required",
      );
      assert.equal(
        realCalls,
        0,
        "unapproved tests must not execute remote tools",
      );
      const passed = await agents.test(actor, imported.versionId, {
        input: { text: "integration" },
        execute: true,
        approved: true,
      });
      assert.equal(passed.ok, true);
      assert.equal(passed.content, "integration");
      assert.equal(realCalls, 1);
      await agents.publish(actor, imported.versionId);
      const http = await agents.create(actor, {
        kind: "tool",
        key: "http_fixture",
        name: "HTTP fixture",
        config: {
          type: "rest",
          description: "HTTP fixture",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          endpoint: {
            url: address + "/http",
            method: "GET",
            credentialId: credential.id,
            resultPath: "data",
          },
        },
      });
      const httpResult = await agents.test(actor, http.versionId, {
        execute: true,
        input: {},
      });
      assert.equal(httpResult.ok, true);
      assert.equal(httpResult.metadata.status, 200);
      assert.match(httpResult.content, /"id":7/);
      await agents.publish(actor, http.versionId);
      assert.equal(
        (
          await service.importTool(actor, created.id, {
            versionId: discovered.id,
            toolName: "echo",
          })
        ).reused,
        true,
      );
      await assert.rejects(
        service.configureServer(actor, created.id, {
          versionId: first.id,
          config: first.config,
        }),
        (e) => e.getStatus() === 409,
      );
      await assert.rejects(
        database.transaction(async (db) =>
          db.query("UPDATE mcp_server_versions SET config=$2 WHERE id=$1", [
            discovered.id,
            "{}",
          ]),
        ),
        /immutable/,
      );
      await service.updateCredential(actor, credential.id, {
        revision: 1,
        secret: "rotated-fixture-token",
      });
      assert.equal(
        (await service.credential(credential.id)).secret,
        "rotated-fixture-token",
      );
      await assert.rejects(
        service.updateCredential(actor, credential.id, {
          revision: 1,
          enabled: false,
        }),
        (e) => e.getStatus() === 409,
      );
      const ws = (
        await client.query(
          "INSERT INTO workspaces(name)VALUES('Other external tools fixture')RETURNING id::int",
        )
      ).rows[0].id;
      await client.query("SET LOCAL ROLE agent_studio_workspace_runtime");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [
        String(ws),
      ]);
      await inWorkspace(ws, async () => {
        assert.equal((await service.credentials()).credentials.length, 0);
        await assert.rejects(service.credential(credential.id), /unavailable/);
        await assert.rejects(
          service.connectionVersion(discovered.id),
          (e) => e.getStatus() === 404,
        );
        await assert.rejects(
          service.createServer(actor, {
            key: "foreign_auth",
            name: "Foreign credential",
            config: {
              url: "https://example.com/mcp",
              credentialId: credential.id,
            },
          }),
          (e) => e.getStatus() === 400,
        );
      });
      await client.query("RESET ROLE");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
