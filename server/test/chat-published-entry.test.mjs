import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nativeChat } from "./helpers/native-chat.mjs";
import { ChatOrchestratorService } from "../dist/chat/chat-orchestrator.service.js";
import { AgentModule } from "../dist/ai/agent/agent.module.js";

test("missing native execution/published resolver fails closed, never invokes a supplied legacy-looking runner or static model", async () => {
  let calls = 0;
  const untrustedFallback = {
    run: () => {
      calls++;
      throw Error("Old runtime must never run");
    },
  };
  for (const [execution, management] of [
    [untrustedFallback, undefined],
    [
      undefined,
      {
        snapshot: () => {
          calls++;
        },
      },
    ],
  ]) {
    const service = new ChatOrchestratorService(execution, {}, management);
    await assert.rejects(
      service.askDetailed("Task", [], ""),
      (error) => error.getResponse().code === "agent_configuration_unavailable",
    );
  }
  assert.equal(calls, 0);
});

test("Chat requires a published entry, pins its own configuration/Prompt and rejects legacy caller overrides", async () => {
  const f = nativeChat({
    respond: () => ({ content: "Pinned native answer" }),
  });
  const invalid = { ...f.snapshot, agents: new Map() };
  const bad = new ChatOrchestratorService(
    { run: () => assert.fail("Invalid snapshot must not execute") },
    f.llm,
    { snapshot: async () => invalid },
  );
  await assert.rejects(
    bad.askDetailed("Task", [], ""),
    (error) => error.getResponse().code === "agent_configuration_unavailable",
  );
  const result = await f.orchestrator.askDetailed(
    "Task",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      configurationSnapshot: {
        configuration: { identity: { persona: "PRIVATE_LEGACY_OVERRIDE" } },
      },
      promptSnapshot: { businessPrompt: "PRIVATE_PROMPT_OVERRIDE" },
    },
  );
  assert.equal(result.result.answer, "Pinned native answer");
  assert.equal(f.requests.length, 1);
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.equal(result.contextSnapshot.agentConfigurationVersion, 1);
  assert.doesNotMatch(
    JSON.stringify(f.requests),
    /PRIVATE_LEGACY_OVERRIDE|PRIVATE_PROMPT_OVERRIDE/,
  );
  const draft = {
    ...f.snapshot,
    agents: new Map([
      [
        1,
        {
          ...f.snapshot.agents.get(1),
          version: { ...f.snapshot.agents.get(1).version, status: "draft" },
        },
      ],
    ]),
  };
  await assert.rejects(
    f.orchestrator.askDetailed(
      "Task",
      [],
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { compositionSnapshot: draft },
    ),
    (error) => error.getResponse().code === "agent_configuration_unavailable",
  );
  assert.equal(f.requests.length, 1);
});

test("production registration and retained admin config inspect no longer import or instantiate the migration kernel", async () => {
  const providers = Reflect.getMetadata("providers", AgentModule).map(
    (provider) =>
      typeof provider === "function" ? provider.name : String(provider.provide),
  );
  assert.ok(providers.includes("AgentExecutionService"));
  assert.ok(providers.includes("DeepAgentExecutionService"));
  assert.ok(
    !providers.some((name) =>
      /PlatformAgentAdapter|PlatformAgentNodes|AgentRunner|AgentLoop|AgentGraph/.test(
        name,
      ),
    ),
  );
  for (const path of [
    "../dist/chat/chat-orchestrator.service.js",
    "../dist/chat/admin-agent-config.controller.js",
  ])
    assert.doesNotMatch(
      await readFile(new URL(path, import.meta.url), "utf8"),
      /require\([^)]*(?:platform-agent-adapter|platform-agent-nodes|agent-loop|agent-runner|agent-graph)/,
    );
});
