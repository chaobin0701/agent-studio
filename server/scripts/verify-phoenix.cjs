// Opt-in genuine local Phoenix ingestion/read-back, no business DB mutation,
// no paid providers; capability fixtures execute the real LangGraph/services/SDK.
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const assert = require("node:assert/strict");
const { readTracingEnvironment } = require("../dist/config/tracing-config.js");
let stage = "collector_health";
(async () => {
  const config = readTracingEnvironment();
  const base = config.endpoint
    .replace(/\/v1\/traces\/?$/, "")
    .replace(/\/$/, "");
  const headers = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};
  const health = await fetch(`${base}/healthz`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(health.ok, "Start local Phoenix first");
  const dir = mkdtempSync(join(tmpdir(), "phoenix-acceptance-"));
  try {
    stage = "capability_execution";
    const includeRunApi =
      process.env.PHOENIX_ACCEPTANCE_INCLUDE_RUN_API === "true";
    if (includeRunApi)
      assert.ok(
        process.env.TEST_DATABASE_URL,
        "Run API acceptance requires an explicitly configured test database",
      );
    const tests = spawnSync(
      process.execPath,
      [
        "--test",
        "test/agent-execution.test.mjs",
        "test/agent-embedding-retrieval.test.mjs",
        "test/phoenix-capabilities.test.mjs",
        "test/langchain-provider.test.mjs",
        "test/specialized-workflows.test.mjs",
        ...(includeRunApi ? ["test/agent-run.test.mjs"] : []),
      ],
      {
        cwd: resolve(__dirname, ".."),
        stdio: "inherit",
        env: {
          ...process.env,
          PHOENIX_ACCEPTANCE_ENDPOINT: `${base}/v1/traces`,
          PHOENIX_ACCEPTANCE_OUTPUT_DIR: dir,
        },
      },
    );
    assert.equal(tests.status, 0, "Capability acceptance failed");
    stage = "persisted_spans_readback";
    const manifest = readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s)),
    );
    assert.ok(manifest.length > 20, "No actual spans submitted");
    const traces = [
      ...new Set(manifest.map((s) => `${s.project}:${s.traceId}`)),
    ];
    const persisted = [];
    for (const key of traces) {
      const [project, id] = key.split(":");
      let rows = [];
      const expected = manifest.filter((s) => s.traceId === id);
      const url = `${base}/v1/projects/${encodeURIComponent(project)}/spans?limit=1000&trace_id=${id}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) rows = (await response.json()).data;
        if (
          expected.every((s) =>
            rows.some((r) => r.context.span_id === s.spanId),
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(
        expected.every((s) => rows.some((r) => r.context.span_id === s.spanId)),
        `Spans missing from local Phoenix (${project})`,
      );
      persisted.push(...rows);
    }
    stage = "trace_tree_validation";
    const names = new Set(persisted.map((s) => s.name));
    for (const name of [
      "model_attempt",
      "tool_attempt",
      "member_agent",
      "deep_agent",
      "agent_execution",
      "workspace_task",
      "workspace_read_file",
      ...(includeRunApi ? ["artifact_selection", "artifact_persistence"] : []),
      "context_authorization",
      "knowledge_base_retrieval",
      "query_embedding",
      "fulltext_recall",
      "vector_recall",
      "fuse_knowledge_candidates",
      "exception_acceptance",
      "tool_http_trace_lookup",
      "tool_remote_trace_lookup",
      "agent_request",
      "conversation_summary",
      "specialized_workflow",
      "workflow_node",
    ]) {
      stage = `required_span:${name}`;
      assert.ok(names.has(name), `Missing ${name}`);
    }
    stage = "native_skill_linkage";
    const automatic = persisted.filter(s => s.attributes["app.layer"] === "framework");
    assert.ok(automatic.length > 10, "Actual framework callback tree was not persisted");
    assert.ok(automatic.every(s => s.span_kind === "CHAIN"), "Framework wrappers must not duplicate paid model spans");
    assert.ok(automatic.every(s => !Object.keys(s.attributes).some(k => /llm.token_count|input.value|output.value/.test(k))));
    assert.ok(
      persisted.some(
        (s) =>
          s.name === "workspace_read_file" &&
          s.attributes["app.skillId"] === "specialist",
      ),
      "Native lazy Skill read missing",
    );
    stage = "sdk_adapter_linkage";
    assert.equal(
      persisted.filter(
        (span) =>
          span.name === "workspace_read_file" &&
          span.attributes["app.skillVersionId"] === 62 &&
          span.attributes["app.skillId"] === "specialist",
      ).length,
      2,
      "Published member Skill and auxiliary read spans missing or duplicated",
    );
    const sdkSpans = persisted.filter(
      (span) =>
        span.name === "model_attempt" &&
        span.attributes["app.localRunId"] === "sdk-version-fixture",
    );
    assert.equal(
      sdkSpans.length,
      2,
      "SDK adapter LLM spans duplicated or missing",
    );
    assert.ok(
      sdkSpans.every(
        (span) =>
          span.attributes["app.modelAdapterVersion"] ===
          "langchain-openai-1.6.2/platform-v1",
      ),
    );
    stage = "native_mcp_linkage";
    assert.ok(
      persisted.some((s) => s.attributes["app.mcpServerId"] === 12),
      "Native MCP server linkage not persisted",
    );
    assert.ok(
      persisted.some((s) => s.attributes["app.toolVersionId"] === 88),
      "HTTP Tool version not persisted",
    );
    stage = "remote_mcp_linkage";
    assert.ok(
      persisted.some(
        (s) =>
          s.attributes["app.toolVersionId"] === 89 &&
          s.attributes["app.mcpServerId"] === 14,
      ),
      "Remote MCP Tool linkage not persisted",
    );
    stage = "summary_linkage";
    assert.ok(
      persisted.some(
        (s) =>
          s.name === "model_attempt" &&
          s.attributes["app.purpose"] === "summary" &&
          s.attributes["app.codePromptVersion"],
      ),
      "Asynchronous summary trace not persisted",
    );
    stage = "index_linkage";
    assert.ok(
      persisted.some((s) => s.attributes["app.indexVersionId"]),
      "Index version missing",
    );
    stage = "prompt_linkage";
    assert.ok(
      persisted.some((s) => s.attributes["app.promptVersionId"] === 8),
      "Prompt version missing",
    );
    stage = "run_linkage";
    assert.ok(
      persisted.some(
        (s) => s.attributes["app.localRunId"] === "phoenix-native-acceptance",
      ),
      "Local Run linkage missing",
    );
    stage = "error_status";
    assert.ok(
      persisted.some((s) => s.status_code === "ERROR"),
      "Failure span missing",
    );
    stage = "metadata_only_privacy";
    assert.doesNotMatch(
      JSON.stringify(persisted),
      /PRIVATE_|GUIDE_FOR_MEMBER|fixture-query-key|Bearer /,
    );
    // Authorization is a legitimate governance span name, not an HTTP header.
    // Inspect actual attribute keys for body/credential capture rather than
    // confusing the "context_authorization" span with a leaked header.
    for (const span of persisted)
      assert.doesNotMatch(
        JSON.stringify(Object.keys(span.attributes)),
        /apiKey|authorization|input\.value|output\.value|llm\.input_messages|llm\.output_messages|http\.request\.headers/i,
      );
    if (includeRunApi) {
      const spans = persisted.filter(
        (s) =>
          s.attributes["app.localRunId"] &&
          s.attributes["app.workspaceId"] === 1 &&
          s.name === "agent_request",
      );
      assert.ok(
        spans.some(
          (s) =>
            s.status_code === "OK" &&
            s.attributes["app.agentVersionId"] &&
            s.attributes["app.modelPlanVersionId"],
        ),
        "Run HTTP request/version linkage missing",
      );
      assert.ok(
        spans.some((s) => s.status_code === "ERROR"),
        "Run HTTP failure trace missing",
      );
    }
    for (const span of persisted)
      if (span.parent_id)
        assert.ok(
          persisted.some(
            (p) =>
              p.context.span_id === span.parent_id &&
              p.context.trace_id === span.context.trace_id,
          ),
          "Broken parent relation",
        );
    console.log(
      JSON.stringify({
        verified: true,
        traceCount: traces.length,
        persistedSpans: persisted.length,
        frameworkSpans: automatic.length,
        kinds: [...new Set(persisted.map((s) => s.span_kind))],
        model: "deterministic acceptance provider",
        storage: "local Phoenix PostgreSQL",
        cloudExport: false,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})().catch(() => {
  console.error(
    `Local Phoenix acceptance failed at ${stage}. No credentials or trace bodies are logged.`,
  );
  process.exitCode = 1;
});
