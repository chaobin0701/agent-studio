import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { ModelManagementService } from "../dist/model-management/model-management.service.js";
import { PromptService } from "../dist/prompts/prompt.service.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import {
  agentSchema,
  toolSchema,
} from "../dist/agent-management/resource.types.js";
import { resourceReferences } from "../dist/agent-management/resource-lifecycle.js";
import { assertIndexCompatible } from "../dist/documents/index-compatibility.js";

test(
  "PostgreSQL: fixed collaboration versions retain dependencies, reject self/nesting/duplicate members and release on removal",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async (t) => {
    const c = new Client({
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT ?? 5433),
      user: process.env.POSTGRES_USER ?? "grounded",
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB ?? "agent_studio",
    });
    await c.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const schema = "collaboration_" + randomUUID().replaceAll("-", "");
      await c.query(`CREATE SCHEMA "${schema}"`);
      await c.query(`SET LOCAL search_path TO "${schema}",public`);
      const dir = new URL("../migrations/", import.meta.url);
      for (const f of (await readdir(dir))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await c.query(
          (await readFile(new URL(f, dir), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      const actor = (
        await c.query(
          "INSERT INTO admins(email,password_hash,display_name) VALUES('multi@example.invalid','fixture','Fixture') RETURNING id::int",
        )
      ).rows[0].id;
      const query = (sql, args) =>
        sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
          ? Promise.resolve({ rows: [] })
          : c.query(sql, args);
      const db = {
        query,
        transaction: async (fn) => {
          await c.query("SAVEPOINT call");
          try {
            const result = await fn({ query });
            await c.query("RELEASE SAVEPOINT call");
            return result;
          } catch (e) {
            await c.query("ROLLBACK TO SAVEPOINT call");
            await c.query("RELEASE SAVEPOINT call");
            throw e;
          }
        },
      };
      const create = async (kind, key, config) => {
        const id = (
          await c.query(
            "INSERT INTO agent_resources(kind,resource_key,name) VALUES($1,$2,$2)RETURNING id::int",
            [kind, key],
          )
        ).rows[0].id;
        const v = (
          await c.query(
            "INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,1,'published',$2)RETURNING id::int",
            [id, JSON.stringify(config)],
          )
        ).rows[0].id;
        if (kind === "agent")
          await c.query(
            "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
            [id, v],
          );
        return { id, v };
      };
      const plan = (
        await c.query(
          "WITH p AS(INSERT INTO model_plans(kind,name)VALUES('llm','Member model')RETURNING id)INSERT INTO model_plan_versions(plan_id,version,status,config)SELECT id,1,'published','{\"deployments\":[]}' FROM p RETURNING id::int,plan_id::int",
        )
      ).rows[0];
      const prompt = (
        await c.query(
          "WITH p AS(INSERT INTO prompt_resources(prompt_key,name,prompt_type)VALUES('member.prompt','Member prompt','system')RETURNING id)INSERT INTO prompt_versions(resource_id,version,status,template)SELECT id,1,'published','General task guide'FROM p RETURNING id::int,resource_id::int",
        )
      ).rows[0];
      const tool = await create(
        "tool",
        "lookup",
        toolSchema.parse({
          type: "builtin",
          target: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
        }),
      );
      const skill = await create("skill", "specialist", {
        description: "Guide",
        instructions: "Guide",
        category: "",
        permissionMode: "agent",
        allowedTools: [],
        allowedKnowledgeBaseIds: [],
        disableModelInvocation: false,
      });
      const base = agentSchema.parse({
        responsibility: "General assistant",
        promptVersionId: prompt.id,
        modelPlanVersionId: plan.id,
        toolVersionIds: [],
        skillVersionIds: [],
        knowledgeBaseIds: [],
        runtime: {},
      });
      const member = await create("agent", "member", {
        ...base,
        toolVersionIds: [tool.v],
        skillVersionIds: [skill.v],
      });
      const entry = await create("agent", "entry", {
        ...base,
        collaboration: { memberVersionIds: [member.v] },
      });
      const registry = new ToolRegistry();
      registry.register({
        name: "lookup",
        description: "Lookup",
        inputSchema: z.object({}),
        execute: async () => ({ success: true, content: "ok" }),
      });
      for (const name of ["search_knowledge", "load_skill"])
        registry.register({
          name,
          description: name,
          inputSchema: z.object({}),
          execute: async () => ({ success: true, content: "ok" }),
        });
      const manager = new AgentManagementService(
        db,
        { agent: DEFAULT_AGENT_CONFIGURATION },
        registry,
        new SkillRegistry(),
        { snapshot: async () => ({ environment: "dev", prompts: {} }) },
        {},
      );
      const next = (
        await c.query(
          "INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,2,'published',$2)RETURNING id::int",
          [member.id, JSON.stringify(base)],
        )
      ).rows[0].id;
      await c.query(
        "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
        [member.id, next],
      );
      await t.test(
        "published entry pins old member while its new version becomes independently current",
        async () => {
          const snapshot = await manager.snapshot(entry.id);
          assert.equal(snapshot.mode, "multi");
          assert.equal(snapshot.agents.has(member.v), true);
          assert.equal(snapshot.agents.has(next), false);
          assert.equal(snapshot.agents.get(member.v).tools.has("lookup"), true);
          assert.equal(
            snapshot.agents.get(member.v).tools.has("delegate_agent"),
            false,
          );
          assert.equal(
            snapshot.agents.get(member.v).skills.get("specialist").versionId,
            skill.v,
          );
          assert.equal(snapshot.collaboration.maxModelCalls, 32);
          assert.ok(Object.isFrozen(snapshot.collaboration));
          assert.equal(
            (await manager.options()).members.some((v) => v.id === entry.v),
            false,
            "coordinators are not selectable members",
          );
          assert.ok(
            (await resourceReferences(c, "agent", member.id)).some(
              (r) => r.versionId === entry.v && r.usage === "current",
            ),
          );
          for (const resource of [member, skill, tool])
            await assert.rejects(
              manager.lifecycle(actor, resource.id, "delete"),
              (e) => e.getStatus() === 409,
            );
          assert.ok(
            (
              await new ModelManagementService(db, {}, {}).references(
                "llm",
                "plans",
                plan.plan_id,
              )
            ).some((r) => r.id === member.id && r.usage === "current"),
          );
          assert.ok(
            (await new PromptService(db).usage(prompt.resource_id)).some(
              (r) => r.agentVersionId === member.v && r.isCurrent,
            ),
          );
          assert.ok(
            (await manager.skillUsage(skill.id)).agents.some(
              (r) => r.agentVersionId === member.v && r.isCurrent,
            ),
          );
        },
      );
      await t.test(
        "self, coordinator members and duplicate versions of one member are rejected",
        async () => {
          for (const [ids, message] of [
            [[entry.v], "自己"],
            [[entry.v, member.v], "自己"],
            [[member.v, next], "只能选择一个"],
          ]) {
            const version = {
              id: entry.v,
              resourceId: entry.id,
              kind: "agent",
              status: "published",
              config: { ...base, collaboration: { memberVersionIds: ids } },
            };
            await assert.rejects(
              manager.validate(c, version),
              (e) => e.getStatus() === 400 && e.message.includes(message),
            );
          }
          const invalid = await create("agent", "nested", {
            ...base,
            collaboration: { memberVersionIds: [entry.v] },
          });
          await assert.rejects(
            manager.snapshot(invalid.id),
            (e) => e.getStatus() === 400 && e.message.includes("嵌套"),
          );
          await manager.lifecycle(actor, invalid.id, "delete");
        },
      );
      await t.test(
        "pure-vector compatibility checks protect pinned historical members too",
        async () => {
          const kb = (
            await c.query(
              "INSERT INTO knowledge_bases(name,draft_config,enabled_for_chat)VALUES('Pinned vector library','{}',true)RETURNING id::int",
            )
          ).rows[0].id;
          const vectorMember = await create("agent", "vector_member", {
            ...base,
            knowledgeBaseIds: [kb],
            retrieval: { ...base.retrieval, retrievalMode: "vector" },
          });
          const newer = (
            await c.query(
              "INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,2,'published',$2)RETURNING id::int",
              [vectorMember.id, JSON.stringify(base)],
            )
          ).rows[0].id;
          await c.query(
            "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
            [vectorMember.id, newer],
          );
          const coordinator = await create("agent", "vector_coordinator", {
            ...base,
            collaboration: { memberVersionIds: [vectorMember.v] },
          });
          await assert.rejects(
            assertIndexCompatible(db, kb, { indexMode: "economy" }),
            (e) => e.getStatus() === 409,
          );
          await manager.lifecycle(actor, coordinator.id, "archive");
          await assertIndexCompatible(db, kb, { indexMode: "economy" });
        },
      );
      await t.test(
        "removing the coordinator releases its pins but preserves member history",
        async () => {
          await manager.lifecycle(actor, entry.id, "archive");
          assert.ok(
            (await resourceReferences(c, "skill", skill.id)).every(
              (r) => r.usage !== "current",
            ),
          );
          await manager.lifecycle(actor, tool.id, "archive");
          await manager.lifecycle(actor, skill.id, "delete");
          await manager.lifecycle(actor, member.id, "delete");
          assert.equal(
            (
              await c.query(
                "SELECT 1 FROM agent_resource_versions WHERE id=$1",
                [member.v],
              )
            ).rows.length,
            1,
          );
        },
      );
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  },
);
