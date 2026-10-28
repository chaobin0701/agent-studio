import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readStoredTrace } = require("../scripts/langsmith-readback.cjs");
const options = { endpoint: "https://fixture.invalid", apiKey: "fixture" };

test("cloud acceptance reads API-sized pages and waits for indexed error/token fields", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.limit, 100);
    assert.equal(body.trace, "root");
    assert.ok(body.select.includes("session_id"));
    calls++;
    return Response.json({
      runs: [
        {
          id: "root",
          name: "model_attempt",
          run_type: "llm",
          total_tokens: calls === 1 ? 0 : 12,
        },
      ],
    });
  });
  const rows = await readStoredTrace(
    options,
    { runId: "root" },
    ["model_attempt"],
    1,
    (runs) => runs[0].total_tokens === 12,
  );
  assert.equal(calls, 2);
  assert.equal(rows[0].total_tokens, 12);
});

test("cloud acceptance respects throttling without exposing response bodies", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response("PRIVATE_RESPONSE", {
          status: 429,
          headers: { "retry-after": "1" },
        })
      : Response.json({
          runs: [{ id: "root", name: "agent_request", run_type: "chain" }],
        });
  });
  const rows = await readStoredTrace(options, { runId: "root" });
  assert.equal(calls, 2);
  assert.equal(rows.length, 1);
});
