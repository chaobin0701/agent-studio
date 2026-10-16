import { nativeChat } from "./helpers/native-chat.mjs";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  capabilityOutputs,
  selectCapabilityOutputs,
} from "../dist/ai/runtime/capability-output.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";

test("capability output accepts explicit bounded JSON artifacts/references, not arbitrary data or invalid live values", () => {
  const cycle = {};
  cycle.self = cycle;
  const normalized = capabilityOutputs(
    {
      success: true,
      content: "ok",
      data: { secret: "not an artifact" },
      artifacts: [
        { kind: "report", data: { title: "Report", apiKey: "PRIVATE_KEY" } },
        { kind: "bad", data: new Map() },
        { kind: "cycle", data: cycle },
        { kind: "huge", data: "x".repeat(2000) },
      ],
      references: [
        {
          kind: "external",
          id: "source",
          metadata: { authorization: "Bearer PRIVATE_KEY" },
        },
      ],
    },
    "tool-call",
    1000,
  );
  assert.equal(normalized.artifacts.length, 1);
  assert.equal(normalized.artifacts[0].id, "tool-call:0");
  assert.equal(normalized.artifacts[0].data.apiKey, "[REDACTED]");
  assert.equal(normalized.references[0].metadata.authorization, "[REDACTED]");
  assert.doesNotMatch(
    JSON.stringify(normalized),
    /PRIVATE_KEY|not an artifact/,
  );
  assert.deepEqual(
    capabilityOutputs(
      {
        success: false,
        content: "failure",
        artifacts: [{ kind: "report", data: {} }],
      },
      "call",
      1000,
    ),
    { artifacts: [], references: [] },
  );
  assert.deepEqual(
    selectCapabilityOutputs(
      { status: "refused", artifactIds: ["tool-call:0"] },
      normalized,
    ),
    {},
  );
  assert.deepEqual(
    selectCapabilityOutputs(
      {
        status: "answered",
        artifactIds: ["made-up"],
        referenceIds: ["made-up"],
      },
      normalized,
    ),
    {},
  );
});

test("real generic tool Agent returns selected artifacts and structured output without products, KB, extra model call or inferred artifacts", async () => {
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  configuration.identity = {
    name: "Report assistant",
    role: "General reporting",
    persona: "Complete tasks using authorized capabilities.",
  };
  configuration.answeringInstructions = "Complete tasks";
  configuration.answerInstructions = "Respond clearly";
  configuration.enabledSkills = [];
  configuration.runtime.allowedTools = ["create_report"];
  const tool = {
    name: "create_report",
    description: "Create authorized report",
    inputSchema: z.object({}).strict(),
    execute: async () => ({
      success: true,
      content: "Report ready",
      data: { operation: "done" },
      artifacts: [
        {
          kind: "report",
          id: "report-one",
          data: {
            rows: [{ name: "Result", value: 42 }],
            token: "PRIVATE_TOKEN",
          },
        },
      ],
      references: [
        { kind: "source", id: "source-one", title: "Verified source" },
      ],
    }),
  };
  let calls = 0;
  const host = nativeChat({
    configuration,
    tools: [tool],
    respond: async (request) => {
      calls++;
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /productContext|PRIVATE_TOKEN/,
      );
      if (calls === 1)
        return {
          content: "",
          toolCalls: [
            { id: "report-call", name: "create_report", arguments: {} },
          ],
          model: "fixture",
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          finishReason: "tool_calls",
        };
      const message = request.messages.find((m) => m.role === "tool");
      const body = JSON.parse(message.content);
      assert.equal(body.artifacts[0].id, "report-one");
      assert.equal(body.artifacts[0].data.token, "[REDACTED]");
      return {
        content: JSON.stringify({
          type: "final",
          status: "answered",
          answer: "Report completed",
          citationIds: [],
          artifactIds: ["report-one", "not-created"],
          referenceIds: ["source-one", "not-authorized"],
          structured: { count: 1, authorization: "Bearer PRIVATE_TOKEN" },
        }),
        toolCalls: [],
        model: "fixture",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        finishReason: "stop",
      };
    },
  });
  const result = await host.runner.run({
    question: "Create report",
    summary: "",
    recentHistory: [],
  });
  assert.equal(calls, 2);
  assert.equal(result.contextSnapshot.products, undefined);
  assert.equal(result.result.answer, "Report completed");
  assert.equal(result.result.artifacts.length, 1);
  assert.deepEqual(
    result.result.references.map((r) => r.id),
    ["source-one"],
  );
  assert.equal(result.result.structured.count, 1);
  assert.equal(result.output.artifacts[0].kind, "report");
  assert.equal(result.output.usage.totalTokens, 30);
  assert.deepEqual(result.output.structured, {
    count: 1,
    authorization: "[REDACTED]",
  });
  assert.doesNotMatch(
    JSON.stringify(result.output),
    /PRIVATE_TOKEN|product|refused|citations/,
  );
  assert.deepEqual(result.contextSnapshot.graphNodes, [
    "model",
    "tools",
    "model",
    "finalize",
  ]);
});

test("reference identity is kind + id; repeated authorized projections keep the first metadata without duplicate citations", async () => {
  const { uniqueCapabilityReferences } = await import(
    "../dist/ai/runtime/capability-output.js"
  );
  const refs = [
    { kind: "knowledge", id: "7", metadata: { indexVersionId: 3 } },
    { kind: "knowledge", id: "7", metadata: { indexVersionId: 4 } },
    { kind: "document", id: "7" },
  ];
  const unique = uniqueCapabilityReferences(refs);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].metadata.indexVersionId, 3);
  assert.equal(
    capabilityOutputs(
      { success: true, content: "", references: refs },
      "call",
      3000,
    ).references.length,
    2,
  );
  const { finalOutput } = await import(
    "../dist/ai/deep-agents/final-output.js"
  );
  assert.equal(
    finalOutput(
      "Plain answer",
      { references: refs, artifacts: [] },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ).references.length,
    2,
  );
});
