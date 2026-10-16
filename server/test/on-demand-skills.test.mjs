import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import { AdminChatTraceController } from "../dist/chat/admin-chat-trace.controller.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";

const guide = {
  id: "own-guide",
  name: "Guide",
  description: "Read only when needed",
  version: "1",
  systemInstructions:
    "PRIVATE_GUIDE_BODY: read authorized records only; global_only is not a capability grant.",
};
const input = { question: "Task", summary: "", recentHistory: [] };
const call = (id, name, args = {}) => ({
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});
const final = { content: "Public answer" };
function fixture(replies, tools = [], limits = {}) {
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  Object.assign(configuration.runtime, limits);
  return nativeChat({
    configuration,
    tools,
    skills: [guide],
    respond: (request) => {
      const reply = replies.shift();
      assert.ok(reply, "Unexpected extra model call");
      return typeof reply === "function" ? reply(request) : reply;
    },
  });
}

test("greetings finish in one native model without classification, retrieval, preflight or implicit Skill Agent", async () => {
  for (const greeting of ["你好", "Hello", "こんにちは"]) {
    const f = fixture([{ content: greeting }]);
    const result = await f.runner.run({ ...input, question: greeting });
    assert.equal(result.output.answer, greeting);
    assert.equal(f.requests.length, 1);
    assert.equal(result.toolCalls.length, 0);
    assert.deepEqual(result.contextSnapshot.specialistTasks, []);
    assert.equal(result.contextSnapshot.preflight, undefined);
    assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_GUIDE_BODY/);
    assert.ok(
      !f.requests[0].tools.some((tool) =>
        ["load_skill", "run_skill", "task", "execute"].includes(tool.name),
      ),
    );
  }
});

test("ordinary authorized reads preserve native call pairs without loading a specialist or replaying old bodies", async () => {
  let reads = 0;
  const tool = {
    name: "list_records",
    description: "List",
    inputSchema: z.object({}),
    execute: async () => {
      reads++;
      return { success: true, content: "Records" };
    },
  };
  const f = fixture(
    [
      call("list", tool.name),
      (request) => {
        assert.equal(
          request.messages.find((message) => message.role === "tool")
            .toolCallId,
          "list",
        );
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /PRIVATE_GUIDE_BODY/,
        );
        return final;
      },
    ],
    [tool],
  );
  const result = await f.runner.run({
    ...input,
    priorTranscript: [{ role: "tool", content: "PRIVATE_PRIOR_BODY" }],
  });
  assert.equal(reads, 1);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(result.contextSnapshot.specialistTasks, []);
  assert.equal(
    result.contextSnapshot.agentTranscript.some(
      (message) => message.role === "tool",
    ),
    false,
  );
  assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_PRIOR_BODY/);
});

test("native Skill body is read lazily into a tool result, not promoted to system instructions or a child model", async () => {
  const progress = [];
  const f = fixture([
    call("guide-read", "read_file", {
      file_path: "/skills/own-guide/SKILL.md",
    }),
    (request) => {
      assert.match(
        request.messages.find((message) => message.role === "tool").content,
        /PRIVATE_GUIDE_BODY/,
      );
      assert.doesNotMatch(
        request.messages.find((message) => message.role === "system").content,
        /PRIVATE_GUIDE_BODY/,
      );
      return final;
    },
  ]);
  const result = await f.runner.run(input, {
    onProgress: (event) => progress.push(event),
  });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(result.contextSnapshot.specialistTasks, []);
  assert.ok(result.contextSnapshot.graphNodes.includes("skills"));
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_GUIDE_BODY/);
});

test("unknown/traversal Skill paths cannot read global files and remain recoverable safe tool results", async () => {
  for (const path of ["/skills/unknown/SKILL.md", "../../etc/passwd"]) {
    const f = fixture([
      call("invalid", "read_file", { file_path: path }),
      (request) => {
        assert.equal(
          request.messages.find((message) => message.role === "tool")
            .toolCallId,
          "invalid",
        );
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /PRIVATE_GUIDE_BODY/,
        );
        return final;
      },
    ]);
    const result = await f.runner.run(input);
    assert.equal(result.output.answer, "Public answer");
    assert.equal(f.requests.length, 2);
    assert.ok(result.toolCalls.some((tool) => tool.ok === false));
  }
});

test("reading a guide cannot expand runtime capabilities or evade the shared tool cap", async () => {
  const f = fixture([
    call("guide", "read_file", { file_path: "/skills/own-guide/SKILL.md" }),
    call("forbidden", "global_only"),
    final,
  ]);
  const result = await f.runner.run(input);
  assert.ok(
    result.toolCalls.some((tool) => tool.errorCode === "tool_not_allowed"),
  );
  assert.ok(
    f.requests.every(
      (request) => !request.tools.some((tool) => tool.name === "global_only"),
    ),
  );
  let reads = 0;
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({}),
    execute: async () => {
      reads++;
      return { success: true, content: "Record" };
    },
  };
  const limited = fixture(
    [
      call("guide", "read_file", { file_path: "/skills/own-guide/SKILL.md" }),
      call("over", tool.name),
      final,
    ],
    [tool],
    { maxToolCalls: 1, maxPlannerRounds: 3 },
  );
  const stopped = await limited.runner.run(input);
  assert.equal(reads, 0);
  assert.equal(limited.requests.length, 3);
  assert.ok(
    stopped.toolCalls.some(
      (tool) => tool.errorCode === "tool_call_limit_exceeded",
    ),
  );
  assert.equal(stopped.contextSnapshot.executionBudget.toolCalls, 1);
});

test("five native authorized operations can share a batch and need only two model decisions", async () => {
  let reads = 0;
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({ id: z.number() }),
    execute: async () => {
      reads++;
      return { success: true, content: "Record" };
    },
  };
  const f = fixture(
    [
      {
        content: "",
        toolCalls: Array.from({ length: 5 }, (_, id) => ({
          id: `read-${id}`,
          name: tool.name,
          arguments: { id },
        })),
      },
      final,
    ],
    [tool],
    { maxToolCalls: 5, maxPlannerRounds: 2 },
  );
  await f.runner.run(input);
  assert.equal(f.requests.length, 2);
  assert.equal(reads, 5);
});

test("prior raw tool facts are never replayed as current authorized memory", async () => {
  const f = fixture([
    (request) => {
      assert.doesNotMatch(JSON.stringify(request.messages), /PRIVATE_OLD_FACT/);
      return final;
    },
  ]);
  const result = await f.runner.run({
    ...input,
    priorTranscript: [{ role: "tool", content: "PRIVATE_OLD_FACT" }],
  });
  assert.equal(result.output.answer, "Public answer");
  assert.equal(result.toolCalls.length, 0);
});

test("native business refusal preserves its explanation without tools, repair or an extra answer call", async () => {
  const text = "Please provide the exact model before a price can be verified";
  const f = fixture([
    { content: JSON.stringify({ answer: text, status: "refused" }) },
  ]);
  const result = await f.runner.run(input);
  assert.equal(result.result.refused, true);
  assert.equal(result.result.answer, text);
  assert.equal(f.requests.length, 1);
});
test("ordinary trace readers cannot obtain loaded Skill instructions or complete model requests", async () => {
  const secretInstructions = "INTERNAL_SPECIALIST_GUIDANCE";
  const snapshot = {
    systemPrompt: secretInstructions,
    modelCalls: [{ request: { messages: [{ content: secretInstructions }] } }],
    loadedSkills: [
      { id: "product_consultation", version: "2.0.0", name: "产品咨询" },
    ],
    toolResults: [
      { tool: "load_skill", result: secretInstructions },
      { tool: "list_products", result: "catalog" },
    ],
    executionSteps: [
      { type: "tool_call", name: "load_skill", result: secretInstructions },
    ],
    agentTranscript: [
      { role: "tool", toolName: "load_skill", content: secretInstructions },
    ],
  };
  const controller = new AdminChatTraceController({
    query: async () => ({
      rows: [
        {
          id: "trace",
          contextSnapshot: snapshot,
          rawModelOutput: secretInstructions,
        },
      ],
    }),
  });
  const detail = await controller.detail("trace");
  assert.ok(!JSON.stringify(detail).includes(secretInstructions));
  assert.equal(detail.contextSnapshot.toolResults[1].result, "catalog");
  assert.equal(
    detail.contextSnapshot.loadedSkills[0].id,
    "product_consultation",
  );
  assert.equal(
    snapshot.agentTranscript[0].content,
    secretInstructions,
    "original stored debug context remains intact",
  );
});

test("orchestrator publishes the catalog without automatically preselecting or loading a Skill", async () => {
  const r = nativeChat({
    skills: [guide],
    respond: () => ({ content: "直接回复" }),
  });
  const { orchestrator } = r;
  const result = await orchestrator.askDetailed("你们有哪些产品？", [], "");
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.equal(result.contextSnapshot.toolCalls.length, 0);
  assert.equal(r.requests.length, 1);
  const prompt = r.requests[0].messages.find(
    (message) => message.role === "system",
  ).content;
  assert.match(prompt, /own-guide/);
  assert.doesNotMatch(
    prompt,
    new RegExp(
      guide.systemInstructions
        .slice(0, 30)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.equal(result.contextSnapshot.preflight, undefined);
  await assert.rejects(
    orchestrator.askDetailed(
      "你好",
      [],
      "",
      undefined,
      undefined,
      undefined,
      "question_answering",
    ),
    (error) => error.getStatus() === 400,
  );
});
