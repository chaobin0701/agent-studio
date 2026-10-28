// Shared explicit acceptance helper. Reads only the trace created by the caller.
const assert = require("node:assert/strict");
async function readStoredTrace(
  options,
  mapping,
  expectedNames = [],
  minimumRuns = 1,
  ready = () => true,
) {
  const headers = {
    "x-api-key": options.apiKey,
    "Content-Type": "application/json",
    ...(options.workspaceId ? { "x-tenant-id": options.workspaceId } : {}),
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(options.endpoint + "/runs/query", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers,
      body: JSON.stringify({
        trace: mapping.rootRunId ?? mapping.runId,
        limit: 100,
        select: [
          "id",
          "name",
          "run_type",
          "error",
          "extra",
          "parent_run_id",
          "trace_id",
          "session_id",
          "dotted_order",
          "prompt_tokens",
          "completion_tokens",
          "total_tokens",
          "inputs",
          "outputs",
        ],
      }),
    });
    if (response.status === 403) {
      await response.body?.cancel();
      throw Object.assign(new Error("LangSmith read permission required"), {
        code: "read_permission_required",
      });
    }
    if (response.status === 429) {
      const delay = Math.min(
        5000,
        Math.max(
          1000,
          (Number(response.headers.get("retry-after")) || 2) * 1000,
        ),
      );
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    assert.ok(
      response.ok,
      "LangSmith trace read failed (HTTP " + response.status + ")",
    );
    const result = await response.json(),
      rows = result.runs ?? [];
    assert.ok(
      !result.cursors?.next,
      "Acceptance trace unexpectedly exceeds the read limit",
    );
    if (
      rows.length >= minimumRuns &&
      expectedNames.every((name) => rows.some((row) => row.name === name)) &&
      ready(rows)
    ) {
      return rows.map((row) => {
        const metadata = row.extra?.metadata ?? {};
        return {
          ...row,
          span_kind: row.run_type.toUpperCase(),
          status_code: row.error ? "ERROR" : "OK",
          attributes: {
            ...Object.fromEntries(
              Object.entries(metadata).map(([key, value]) => [
                "app." + key,
                value,
              ]),
            ),
          },
        };
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "LangSmith trace not fully ingested before acceptance deadline",
  );
}
module.exports = { readStoredTrace };
