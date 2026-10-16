import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { Module } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { DatabaseService } from "../dist/database.service.js";
import { WorkspaceService } from "../dist/workspaces/workspace.service.js";
import { AppConfigService } from "../dist/config/config.service.js";
import { AgentManagementController } from "../dist/agent-management/agent-management.controller.js";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";
import { AdminAuthGuard } from "../dist/admin/admin-auth.guard.js";
import { PermissionGuard } from "../dist/admin/permission.guard.js";
import { RequestContextMiddleware } from "../dist/security/request-context.middleware.js";
import { HttpExceptionFilter } from "../dist/security/http-exception.filter.js";

// A real loopback HTTP server and PostgreSQL runtime RLS role, never AppModule/
// pg-boss, main migration history, main credentials or production resources.
test(
  "HTTP + PostgreSQL: Skill bundle import/export, immutable resources, revision conflicts, reader permissions and workspace isolation",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async () => {
    const root = new Client({ connectionString: process.env.DATABASE_URL });
    const schema = "skill_http_" + randomUUID().replaceAll("-", "");
    let db, app;
    await root.connect();
    try {
      await root.query("BEGIN");
      await root.query(`CREATE SCHEMA ${schema}`);
      await root.query(`SET LOCAL search_path TO ${schema},public`);
      const directory = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(directory))
        .filter((file) => file.endsWith(".sql"))
        .sort())
        await root.query(
          (await readFile(new URL(file, directory), "utf8")).split(
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
            "INSERT INTO admins(email,password_hash,display_name) VALUES('skill-http-owner@example.invalid','fixture','owner') RETURNING id",
          )
        ).rows[0].id,
      );
      const reader = Number(
        (
          await db.platformQuery(
            "INSERT INTO admins(email,password_hash,display_name) VALUES('skill-http-reader@example.invalid','fixture','reader') RETURNING id",
          )
        ).rows[0].id,
      );
      const workspaces = new WorkspaceService(db);
      const a = await workspaces.create(actor, { name: "Skill HTTP A" });
      const b = await workspaces.create(actor, { name: "Skill HTTP B" });
      await workspaces.setMember(actor, a.id, {
        adminId: reader,
        role: "reader",
      });
      const service = new AgentManagementService(
        db,
        {},
        new ToolRegistry(),
        new SkillRegistry(),
        {},
        {},
      );
      // Expose the real service methods without its production bootstrap hook:
      // fixture initialization is explicit; no seeds/jobs run on HTTP startup.
      const managed = Object.fromEntries(
        [
          "parseSkillDocument",
          "create",
          "update",
          "get",
          "skillDraft",
          "test",
          "publish",
          "skillDocument",
        ].map((name) => [name, service[name].bind(service)]),
      );
      const config = {
        jwt: { issuer: "skill-http-fixture", audience: "skill-http-fixture" },
      };
      const jwt = new JwtService({
        secret: randomUUID(),
        signOptions: {
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
          expiresIn: "10m",
        },
      });
      class Fixture {}
      Module({
        controllers: [AgentManagementController],
        providers: [
          { provide: AgentManagementService, useValue: managed },
          { provide: AppConfigService, useValue: config },
          { provide: JwtService, useValue: jwt },
          {
            provide: DatabaseService,
            useValue: {
              db: db.db,
              platformQuery: db.platformQuery.bind(db),
              query: db.query.bind(db),
            },
          },
          {
            provide: AdminAuthGuard,
            useValue: new AdminAuthGuard(jwt, db, config),
          },
          {
            provide: PermissionGuard,
            useValue: new PermissionGuard(new Reflector(), db),
          },
        ],
      })(Fixture);
      app = await NestFactory.create(Fixture, {
        logger: false,
        abortOnError: false,
      });
      app.useBodyParser("json", { limit: "512kb" });
      const middleware = new RequestContextMiddleware();
      app.use((request, response, next) =>
        middleware.use(request, response, next),
      );
      app.setGlobalPrefix("api");
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0, "127.0.0.1");
      const base = (await app.getUrl()) + "/api/admin/agent-resources";
      const ownerToken = await jwt.signAsync({
        sub: String(actor),
        sessionVersion: 0,
      });
      const readerToken = await jwt.signAsync({
        sub: String(reader),
        sessionVersion: 0,
      });
      async function http(
        path,
        { method = "GET", body, token = ownerToken, workspace = a.id } = {},
      ) {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "X-Workspace-ID": String(workspace),
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      }
      const bundle = {
        format: "agent-skill-bundle",
        version: 1,
        document:
          "---\nname: http-resource-skill # comment\ndescription: Use reference when needed\nallowed-tools: execute_shell\nallowed-kbs: [999]\n---\n\nRead references/guide.md.\n",
        resources: [
          { path: "references/guide.md", content: "PRIVATE_HTTP_REFERENCE" },
          { path: "scripts/example.sh", content: "echo NEVER_EXECUTED" },
        ],
      };
      assert.equal(
        (
          await http("/skill-bundle", {
            method: "POST",
            body: bundle,
            token: "",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await http("/skill-bundle", {
            method: "POST",
            body: bundle,
            token: readerToken,
          })
        ).status,
        403,
      );
      const parsed = await http("/skill-bundle", {
        method: "POST",
        body: bundle,
      });
      assert.equal(parsed.status, 201);
      assert.deepEqual(parsed.body.config.resources, bundle.resources);
      const created = await http("", {
        method: "POST",
        body: {
          kind: "skill",
          key: parsed.body.key,
          name: parsed.body.name,
          config: parsed.body.config,
        },
      });
      assert.equal(created.status, 201);
      const { resourceId, versionId } = created.body;
      const read = await http(`/${resourceId}`, { token: readerToken });
      assert.equal(read.status, 200);
      assert.deepEqual(read.body.versions[0].config.allowedTools, []);
      assert.deepEqual(
        read.body.versions[0].config.allowedKnowledgeBaseIds,
        [],
      );
      assert.equal(
        (await http(`/versions/${versionId}/test`, { method: "POST" })).status,
        201,
      );
      assert.equal(
        (await http(`/versions/${versionId}/publish`, { method: "POST" }))
          .status,
        201,
      );
      assert.equal(
        (
          await http(`/versions/${versionId}`, {
            method: "PATCH",
            body: { revision: 1, config: parsed.body.config },
          })
        ).status,
        409,
      );
      const exported = await http(
        `/versions/${versionId}/skill-document?format=portable`,
        { token: readerToken },
      );
      assert.equal(exported.status, 200);
      assert.deepEqual(exported.body.bundle.resources, bundle.resources);
      assert.match(exported.body.bundle.document, /# comment/);
      assert.doesNotMatch(exported.body.bundle.document, /allowed-kbs/);
      const reparsed = await http("/skill-bundle", {
        method: "POST",
        body: exported.body.bundle,
      });
      assert.deepEqual(reparsed.body.config.resources, bundle.resources);
      const draft = await http(`/skills/${resourceId}/draft`, {
        method: "POST",
        body: {},
      });
      assert.equal(draft.status, 201);
      const updated = {
        ...parsed.body.config,
        resources: [
          { path: "assets/template.txt", content: "Revised template" },
        ],
      };
      assert.equal(
        (
          await http(`/versions/${draft.body.versionId}`, {
            method: "PATCH",
            body: { revision: 1, config: updated },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await http(`/versions/${draft.body.versionId}`, {
            method: "PATCH",
            body: { revision: 1, config: parsed.body.config },
          })
        ).status,
        409,
      );
      const after = await http(`/${resourceId}`);
      assert.deepEqual(
        after.body.versions.find((version) => version.id === versionId).config
          .resources,
        bundle.resources,
      );
      assert.deepEqual(
        after.body.versions.find(
          (version) => version.id === draft.body.versionId,
        ).config.resources,
        updated.resources,
      );
      const denied = await http(`/versions/${versionId}/skill-document`, {
        workspace: b.id,
      });
      assert.equal(denied.status, 404);
      assert.doesNotMatch(
        JSON.stringify(denied.body),
        /PRIVATE_HTTP_REFERENCE|NEVER_EXECUTED/,
      );
      assert.equal(
        (
          await http(`/versions/${versionId}/skill-document`, {
            workspace: b.id,
            token: readerToken,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await http("/skill-bundle", {
            method: "POST",
            body: {
              ...bundle,
              resources: [{ path: "references/../secret", content: "bad" }],
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await http("/skill-bundle", {
            method: "POST",
            body: { ...bundle, executable: true },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await http("/skill-bundle", {
            method: "POST",
            body: { ...bundle, document: "x".repeat(513 * 1024) },
          })
        ).status,
        413,
      );
      const legacy = await http("", {
        method: "POST",
        body: {
          kind: "skill",
          key: "long_legacy_description",
          name: "Legacy description fixture",
          config: {
            description: "x".repeat(1025),
            instructions: "Legacy body",
            allowedTools: [],
            allowedKnowledgeBaseIds: [],
          },
        },
      });
      assert.equal(legacy.status, 201);
      const legacyExport = await http(
        `/versions/${legacy.body.versionId}/skill-document?format=portable`,
        { token: readerToken },
      );
      assert.equal(legacyExport.status, 400);
      assert.match(legacyExport.body.error.message, /1024/);
      assert.equal(
        (
          await http(`/versions/${legacy.body.versionId}/skill-document`, {
            token: readerToken,
          })
        ).status,
        200,
        "legacy platform export remains readable",
      );
      const audits = (
        await db.platformQuery(
          "SELECT details FROM audit_logs WHERE workspace_id=$1 AND action='agent_resource.draft_updated'",
          [a.id],
        )
      ).rows;
      assert.equal(audits.length, 1);
      assert.doesNotMatch(
        JSON.stringify(audits),
        /PRIVATE_HTTP_REFERENCE|NEVER_EXECUTED|Revised template/,
      );
    } finally {
      if (app) await app.close();
      if (db) await db.onModuleDestroy();
      await root.query("ROLLBACK");
      await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await root.end();
    }
  },
);
