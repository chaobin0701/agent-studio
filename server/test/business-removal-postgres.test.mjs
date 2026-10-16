import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";

test(
  "PostgreSQL: fresh migrations retire business data, disable affected apps/members and preserve unrelated versions",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const schema = "business_removal_" + randomUUID().replaceAll("-", "");
    try {
      await c.query("BEGIN");
      await c.query(`CREATE SCHEMA "${schema}"`);
      await c.query(`SET LOCAL search_path TO "${schema}",public`);
      const dir = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && f < "0055")
        .sort())
        await c.query(
          (await readFile(new URL(file, dir), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      await c.query(
        "INSERT INTO admins(email,password_hash,display_name) VALUES('migration@example.invalid','fixture','migration operator')",
      );
      const resource = async (kind, key, config, status = "published") => {
        const r = (
          await c.query(
            "INSERT INTO agent_resources(kind,resource_key,name) VALUES($1,$2,$2) RETURNING id::int",
            [kind, key],
          )
        ).rows[0].id;
        const v = (
          await c.query(
            "INSERT INTO agent_resource_versions(resource_id,version,status,config) VALUES($1,1,$2,$3) RETURNING id::int",
            [r, status, JSON.stringify(config)],
          )
        ).rows[0].id;
        if (kind === "agent")
          await c.query(
            "UPDATE agent_resources SET current_version_id=$2 WHERE id=$1",
            [r, v],
          );
        return { r, v };
      };
      const seedPrompt = (
        await c.query(
          "INSERT INTO prompt_resources(prompt_key,name,prompt_type) VALUES('agent.default_support.business','Seeded business prompt','system') RETURNING id::int",
        )
      ).rows[0].id;
      await c.query(
        "INSERT INTO prompt_versions(resource_id,version,status,template) VALUES($1,1,'published','Historical business content')",
        [seedPrompt],
      );
      const oldTool = await resource("tool", "list_products", {
        type: "builtin",
        target: "list_products",
      });
      const external = await resource("tool", "records_api", {
        type: "rest",
        endpoint: { connection: "application", url: "/old" },
      });
      const modern = (
        await c.query(
          "INSERT INTO agent_resource_versions(resource_id,version,status,config) VALUES($1,2,'published',$2) RETURNING id::int",
          [
            external.r,
            JSON.stringify({
              type: "rest",
              endpoint: {
                connection: "external",
                url: "https://records.example/v1",
              },
            }),
          ],
        )
      ).rows[0].id;
      const affected = await resource("agent", "custom_business_agent", {
        toolVersionIds: [oldTool.v],
      });
      const legacy = await resource("agent", "default_support", {
        toolVersionIds: [oldTool.v],
      });
      const parent = await resource("agent", "team_agent", {
        collaboration: { memberVersionIds: [affected.v] },
      });
      const unrelated = await resource("agent", "independent_agent", {
        toolVersionIds: [modern],
      });
      const appId = randomUUID();
      await c.query(
        "INSERT INTO integration_apps(id,name,agent_id) VALUES($1,$2,$3)",
        [appId, "Affected external app", affected.r],
      );
      const before = (
        await c.query(
          "SELECT config FROM agent_resource_versions WHERE id=$1",
          [affected.v],
        )
      ).rows[0].config;
      await c.query(
        (
          await readFile(
            new URL("0055_remove_embedded_business.sql", dir),
            "utf8",
          )
        ).split("-- Down Migration")[0],
      );
      await c.query(
        (
          await readFile(
            new URL("0056_archive_seeded_business_prompt.sql", dir),
            "utf8",
          )
        ).split("-- Down Migration")[0],
      );
      assert.ok(
        (
          await c.query(
            "SELECT archived_at FROM prompt_resources WHERE id=$1",
            [seedPrompt],
          )
        ).rows[0].archived_at,
      );
      assert.equal(
        (
          await c.query(
            "SELECT template FROM prompt_versions WHERE resource_id=$1",
            [seedPrompt],
          )
        ).rows[0].template,
        "Historical business content",
      );
      assert.equal(
        (
          await c.query("SELECT to_regclass($1) AS name", [
            schema + ".catalog_products",
          ])
        ).rows[0].name,
        null,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM mcp_capabilities WHERE id='product_catalog'",
          )
        ).rows[0].n,
        0,
      );
      for (const r of [affected, parent, legacy]) {
        const row = (
          await c.query(
            "SELECT enabled,current_version_id FROM agent_resources WHERE id=$1",
            [r.r],
          )
        ).rows[0];
        assert.equal(row.enabled, false);
        assert.equal(row.current_version_id, null);
      }
      assert.equal(
        (
          await c.query("SELECT enabled FROM agent_resources WHERE id=$1", [
            unrelated.r,
          ])
        ).rows[0].enabled,
        true,
      );
      assert.equal(
        (
          await c.query("SELECT deleted_at FROM agent_resources WHERE id=$1", [
            external.r,
          ])
        ).rows[0].deleted_at,
        null,
        "a user-migrated external resource must remain available",
      );
      assert.equal(
        (
          await c.query("SELECT enabled FROM integration_apps WHERE id=$1", [
            appId,
          ])
        ).rows[0].enabled,
        false,
      );
      assert.deepEqual(
        (
          await c.query(
            "SELECT config FROM agent_resource_versions WHERE id=$1",
            [affected.v],
          )
        ).rows[0].config,
        before,
      );
      await c.query("SAVEPOINT immutable_check");
      await assert.rejects(
        c.query("UPDATE agent_resource_versions SET config='{}' WHERE id=$1", [
          affected.v,
        ]),
        /immutable/,
      );
      await c.query("ROLLBACK TO SAVEPOINT immutable_check");
      assert.ok(
        (
          await c.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE action='platform.business_removed'",
          )
        ).rows[0].n > 0,
      );
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
  },
);
