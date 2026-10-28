// Opt-in synthetic cloud acceptance. No paid models, business DB, or publishing.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
if (process.env.AGENT_ACCEPTANCE_ENV_FILE)
  process.loadEnvFile(process.env.AGENT_ACCEPTANCE_ENV_FILE);
const { readTracingEnvironment } = require("../dist/config/tracing-config.js");
const {
  LangSmithExecutionTracer,
} = require("../dist/observability/execution-tracer.js");
const { readStoredTrace } = require("./langsmith-readback.cjs");
let phase = "configuration";
(async () => {
  const options = readTracingEnvironment();
  assert.equal(
    options.enabled,
    true,
    "Explicit LangSmith configuration required",
  );
  let projectId;
  if (options.project) {
    phase = "project_read";
    const response = await fetch(
      options.endpoint +
        "/sessions?name=" +
        encodeURIComponent(options.project) +
        "&limit=10",
      {
        headers: {
          "x-api-key": options.apiKey,
          ...(options.workspaceId
            ? { "x-tenant-id": options.workspaceId }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.status === 403) await response.body?.cancel();
    else {
      assert.ok(response.ok, "LangSmith project read failed");
      const projects = await response.json();
      const matches = projects.filter(
        (project) => project.name === options.project,
      );
      assert.equal(matches.length, 1, "Expected one existing test project");
      projectId = matches[0].id;
    }
  }
  const roots = [],
    conversationId = randomUUID();
  const tracer = new LangSmithExecutionTracer({ ...options, timeoutMs: 10000 });
  try {
    phase = "synthetic_export";
    for (let turn = 0; turn < 2; turn++) {
      await tracer.span(
        "agent_request",
        "chain",
        {
          conversationId,
          localRunId: randomUUID(),
          localTraceId: randomUUID(),
          agentId: 1,
          agentVersionId: 1,
          promptVersionId: 1,
          message: "PRIVATE_USER_SENTINEL",
          apiKey: "PRIVATE_KEY_SENTINEL",
        },
        async (root) => {
          roots.push(tracer.link(root));
          await tracer.span("agent_graph", "chain", {}, async () => {
            if (turn === 0)
              await assert.rejects(
                tracer.span(
                  "model_attempt",
                  "llm",
                  { modelName: "synthetic", modelPlanVersionId: 1, attempt: 1 },
                  async () => {
                    throw Object.assign(new Error("PRIVATE_VENDOR_SENTINEL"), {
                      code: "provider_unavailable",
                    });
                  },
                ),
              );
            await tracer.span(
              "model_attempt",
              "llm",
              {
                modelName: "synthetic",
                modelPlanVersionId: 1,
                attempt: turn === 0 ? 2 : 1,
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
                prompt: "PRIVATE_PROMPT_SENTINEL",
              },
              async () => {},
            );
            await tracer.span(
              "tool_attempt",
              "tool",
              {
                toolVersionId: 1,
                mcpServerId: 1,
                arguments: "PRIVATE_ARGUMENT_SENTINEL",
                result: "PRIVATE_RESULT_SENTINEL",
              },
              async () => {},
            );
            await tracer.span(
              "retrieval",
              "retriever",
              { knowledgeBaseId: 1, indexVersionId: 1 },
              async () => {
                await tracer.span(
                  "embedding",
                  "embedding",
                  { modelName: "synthetic", embeddingPlanVersionId: 1 },
                  async () => {},
                );
              },
            );
          });
        },
      );
    }
    phase = "export_flush";
    assert.equal(await tracer.flush(20000), true);
    assert.equal(
      tracer.metrics.failed,
      0,
      "Collector rejected some spans; no response bodies logged",
    );
    assert.equal(tracer.metrics.dropped, 0);
    let storedRuns = 0;
    try {
      for (const root of roots) {
        phase = "stored_trace_read";
        const rows = await readStoredTrace(
          options,
          root,
          [
            "agent_request",
            "agent_graph",
            "model_attempt",
            "tool_attempt",
            "retrieval",
            "embedding",
          ],
          root === roots[0] ? 7 : 6,
          // Cloud indexing can expose nodes before their error/token updates.
          (rows) =>
            rows.filter((row) => row.error).length ===
              (root === roots[0] ? 1 : 0) &&
            rows
              .filter((row) => row.run_type === "llm" && !row.error)
              .reduce((sum, row) => sum + row.total_tokens, 0) === 12,
        );
        phase = "tree_and_thread";
        assert.equal(rows.length, root === roots[0] ? 7 : 6);
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const row of rows) {
          assert.equal(row.trace_id, root.runId);
          if (projectId) assert.equal(row.session_id, projectId);
          assert.equal(row.extra.metadata.thread_id, conversationId);
          if (row.parent_run_id) {
            assert.ok(byId.has(row.parent_run_id));
            assert.ok(
              row.dotted_order.startsWith(
                byId.get(row.parent_run_id).dotted_order + ".",
              ),
            );
          }
        }
        phase = "token_accounting";
        assert.equal(
          rows
            .filter((row) => row.run_type === "llm" && !row.error)
            .reduce((sum, row) => sum + row.total_tokens, 0),
          12,
        );
        phase = "error_classification";
        const failures = rows.filter((row) => row.error);
        assert.equal(failures.length, root === roots[0] ? 1 : 0);
        if (failures.length) {
          assert.equal(failures[0].run_type, "llm");
          assert.equal(failures[0].error, "provider_unavailable");
        }
        phase = "privacy";
        assert.doesNotMatch(
          JSON.stringify(rows),
          /PRIVATE_|input\.value|output\.value/,
        );
        storedRuns += rows.length;
      }
      console.log(
        JSON.stringify({
          project: options.project ?? options.agentIdentifier,
          projectId,
          acceptedSpans: tracer.metrics.exported,
          storedRuns,
          ingestion: "confirmed",
          turns: 2,
          threadId: conversationId,
          runIds: roots.map((root) => root.runId),
        }),
      );
    } catch (error) {
      if (error.code !== "read_permission_required") throw error;
      console.log(
        JSON.stringify({
          project: options.project ?? options.agentIdentifier,
          acceptedSpans: tracer.metrics.exported,
          ingestion: "unverified",
          reason: "read_permission_required",
          turns: 2,
          threadId: conversationId,
          runIds: roots.map((root) => root.runId),
        }),
      );
    }
  } finally {
    await tracer.close();
  }
})().catch((error) => {
  const reason =
    /^LangSmith trace (?:read failed \(HTTP \d{3}\)|not fully ingested before acceptance deadline)$/u.test(
      error.message,
    )
      ? error.message
      : "validation_failed";
  console.error(
    "LangSmith acceptance failed at " +
      phase +
      " (" +
      reason +
      "). No credentials or trace bodies logged.",
  );
  process.exitCode = 1;
});
