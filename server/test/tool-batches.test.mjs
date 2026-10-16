import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
class RecordReadTool {
 name="get_record_detail";description="Read an authorized record";
 inputSchema=z.object({recordId:z.string().min(1)}).strict();
 planning={canBatch:true,isIdempotent:true};
 resultCacheKey=input=>`record:${input.recordId}`;
 constructor(store){this.store=store;}
 async execute({recordId}){const data=await this.store.getRecordDetail(recordId);return data?{success:true,content:JSON.stringify(data),data}:{success:false,content:"Record not found",errorCode:"record_not_found"};}
}
import { AdminDebugService } from "../dist/chat/admin-debug.service.js";

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const batch = (calls) => ({ content: "", toolCalls: calls });
const final = { content: "Completed authorized task" };
const product = (id) => ({
  id,
  name: `Product ${id}`,
  brand: "Brand",
  categoryId: "category",
  category: "Category",
  summary: "Verified",
  description: `DETAIL_${id}`,
  specifications: { power: "100 W" },
  revision: "v1",
});
const input = {
  question: "Read the authorized records",
  summary: "",
  recentHistory: [],
};
function fixture(replies, tools, settings = {}, skills = []) {
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  Object.assign(configuration.runtime, settings);
  return nativeChat({
    configuration,
    tools,
    skills,
    respond: (request) => {
      const reply = replies.shift();
      assert.ok(reply, "Unexpected extra model call");
      return typeof reply === "function" ? reply(request) : reply;
    },
  });
}
function closedPairs(messages) {
  for (const [index, message] of messages.entries())
    if (message.role === "assistant" && message.toolCalls?.length) {
      assert.deepEqual(
        messages
          .slice(index + 1, index + 1 + message.toolCalls.length)
          .map((result) => [result.role, result.toolCallId]),
        message.toolCalls.map((call) => ["tool", call.id]),
      );
    }
}

test("native framework executes five independent record reads sequentially in one batch, without per-record replanning or another answer call", async () => {
  const ids = ["one", "two", "three", "four", "five"];
  let active = 0,
    maximum = 0;
  const queried = [],
    progress = [];
  const tool = new RecordReadTool({
    getRecordDetail: async (id) => {
      queried.push(id);
      active++;
      maximum = Math.max(maximum, active);
      assert.ok(
        progress.some(
          (event) => event.stage === "tool" && event.status === "running",
        ),
      );
      await new Promise(setImmediate);
      active--;
      return product(id);
    },
  });
  const calls = ids.map((id) =>
    call(`read-${id}`, tool.name, { recordId: id }),
  );
  const f = fixture(
    [
      batch(calls),
      (request) => {
        closedPairs(request.messages);
        assert.deepEqual(
          request.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.toolCallId),
          calls.map((call) => call.id),
        );
        return final;
      },
    ],
    [tool],
    { maxPlannerRounds: 2, maxToolCalls: 5 },
  );
  const result = await f.runner.run(input, {
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(queried, ids);
  assert.equal(maximum, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 5);
  assert.deepEqual(
    result.toolCalls.map((call) => call.ok),
    Array(5).fill(true),
  );
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.doesNotMatch(
    JSON.stringify(progress),
    /DETAIL_|recordId|arguments|100 W/,
  );
});

test("missing and failed native capability results are safe paired messages and never stop other independent reads", async () => {
  const queried = [];
  const tool = new RecordReadTool({
    getRecordDetail: async (id) => {
      queried.push(id);
      if (id === "missing") return null;
      if (id === "throw") throw Error("PRIVATE_DATABASE_DETAILS");
      return product(id);
    },
  });
  const ids = ["missing", "throw", "one", "two"];
  const f = fixture(
    [
      batch(ids.map((id) => call(`read-${id}`, tool.name, { recordId: id }))),
      final,
    ],
    [tool],
  );
  const result = await f.runner.run(input);
  assert.deepEqual(queried, ids);
  assert.deepEqual(
    result.toolCalls.map((call) => call.errorCode ?? "ok"),
    ["record_not_found", "tool_execution_failed", "ok", "ok"],
  );
  closedPairs(f.requests[1].messages);
  assert.equal(
    f.requests[1].messages.filter((message) => message.role === "tool").length,
    4,
  );
  assert.doesNotMatch(JSON.stringify(f.requests), /PRIVATE_DATABASE_DETAILS/);
  assert.equal(result.result.refused, false);
});

test("native batches return every over-budget call ID without performing or charging the rejected operations", async () => {
  const queried = [],
    ids = ["one", "two", "three", "four", "five"];
  const tool = new RecordReadTool({
    getRecordDetail: async (id) => {
      queried.push(id);
      return product(id);
    },
  });
  const f = fixture(
    [
      batch(ids.map((id) => call(`read-${id}`, tool.name, { recordId: id }))),
      final,
    ],
    [tool],
    { maxToolCalls: 2 },
  );
  const result = await f.runner.run(input);
  assert.deepEqual(queried, ["one", "two"]);
  closedPairs(f.requests[1].messages);
  assert.equal(
    f.requests[1].messages.filter((message) => message.role === "tool").length,
    5,
  );
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 2);
  assert.deepEqual(
    result.toolCalls.map((call) => call.errorCode ?? "ok"),
    [
      "ok",
      "ok",
      "tool_call_limit_exceeded",
      "tool_call_limit_exceeded",
      "tool_call_limit_exceeded",
    ],
  );
});

test("native unknown/unauthorized and duplicate calls preserve ID pairing while permitted reads continue", async () => {
  const queried = [];
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({ id: z.string() }).strict(),
    execute: async (args) => {
      queried.push(args.id);
      return { success: true, content: "Read complete" };
    },
  };
  const calls = [
    call("outside", "global_only"),
    call("unknown", "missing_tool"),
    call("first", tool.name, { id: "one" }),
    call("duplicate", tool.name, { id: "one" }),
    call("second", tool.name, { id: "two" }),
  ];
  const f = fixture([batch(calls), final], [tool]);
  const result = await f.runner.run(input);
  assert.deepEqual(queried, ["one", "two"]);
  closedPairs(f.requests[1].messages);
  assert.deepEqual(
    f.requests[1].messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
    calls.map((call) => call.id),
  );
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 2);
  assert.ok(
    result.toolCalls.some((call) => call.errorCode === "duplicate_tool_call"),
  );
  assert.equal(result.result.refused, false);
});

test("a native successful Skill read defers remaining calls losslessly until replanning, without charging or poisoning them", async () => {
  const guide = {
    id: "own-guide",
    name: "Own guide",
    version: "1",
    description: "Own verified guidance",
    systemInstructions: "PRIVATE_SKILL_GUIDANCE: verify authorized records",
  };
  const queried = [];
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({ id: z.string() }).strict(),
    execute: async (args) => {
      queried.push(args.id);
      return { success: true, content: "Read complete" };
    },
  };
  const f = fixture(
    [
      batch([
        call("guide", "read_file", { file_path: "/skills/own-guide/SKILL.md" }),
        call("deferred-one", tool.name, { id: "one" }),
        call("deferred-two", tool.name, { id: "two" }),
      ]),
      (request) => {
        closedPairs(request.messages);
        assert.match(
          JSON.stringify(request.messages),
          /PRIVATE_SKILL_GUIDANCE/,
        );
        assert.deepEqual(queried, []);
        assert.equal(
          request.messages.filter(
            (message) =>
              message.role === "tool" &&
              message.content.includes("tool_requires_replanning"),
          ).length,
          2,
        );
        return batch([
          call("next-one", tool.name, { id: "one" }),
          call("next-two", tool.name, { id: "two" }),
        ]);
      },
      final,
    ],
    [tool],
    {},
    [guide],
  );
  const result = await f.runner.run(input);
  assert.deepEqual(queried, ["one", "two"]);
  assert.equal(f.requests.length, 3);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 3);
  assert.equal(result.toolCalls.filter((call) => call.deferred).length, 2);
  closedPairs(f.requests[2].messages);
  assert.deepEqual(result.contextSnapshot.specialistTasks, []);
});

test("an unavailable Skill file does not defer unrelated reads and cannot obtain a global capability", async () => {
  const queried = [];
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({ id: z.string() }).strict(),
    execute: async (args) => {
      queried.push(args.id);
      return { success: true, content: "Read complete" };
    },
  };
  const f = fixture(
    [
      batch([
        call("missing-guide", "read_file", {
          file_path: "/skills/not-authorized/SKILL.md",
        }),
        call("read", tool.name, { id: "one" }),
      ]),
      final,
    ],
    [tool],
  );
  const result = await f.runner.run(input);
  assert.deepEqual(queried, ["one"]);
  closedPairs(f.requests[1].messages);
  assert.equal(
    result.toolCalls.some((call) => call.deferred),
    false,
  );
  assert.equal(result.result.refused, false);
});

test("native repeated idempotent reads use one trusted request cache and retain both native IDs; no write is reused", async () => {
  let queried = 0;
  const tool = new RecordReadTool({
    getRecordDetail: async (id) => {
      queried++;
      return product(id);
    },
  });
  const f = fixture(
    [
      batch([
        call("first", tool.name, { recordId: "one" }),
        call("again", tool.name, { recordId: "one" }),
      ]),
      final,
    ],
    [tool],
  );
  const result = await f.runner.run(input);
  assert.equal(queried, 1);
  assert.equal(result.toolCalls[1].reused, true);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 1);
  closedPairs(f.requests[1].messages);
  assert.deepEqual(
    f.requests[1].messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
    ["first", "again"],
  );
});

test("historic deferred placeholders remain readable without being diagnosed as failures or budget overruns", () => {
  const deferred = {
    type: "tool_call",
    name: "get_product_detail",
    arguments: { recordId: "one" },
    ok: false,
    deferred: true,
    errorCode: "tool_requires_replanning",
  };
  const contextSnapshot = {
    executionSteps: [
      { type: "tool_call", name: "load_skill", ok: true },
      ...Array.from({ length: 4 }, () => ({ ...deferred })),
      { type: "tool_call", name: "get_product_detail", ok: true },
    ],
  };
  const conversation = {
    id: "fixture",
    messages: [
      { id: 1, role: "user", content: "Read" },
      {
        id: 2,
        role: "assistant",
        content: "Facts",
        citations: [],
        progressEvents: [],
      },
    ],
    runs: [],
    traces: [
      {
        id: "fixture-trace",
        status: "completed",
        userMessageId: 1,
        finalAnswer: "Facts",
        durationMs: 1,
        contextSnapshot,
      },
    ],
  };
  assert.ok(
    new AdminDebugService({})
      .diagnoseConversation(conversation)
      .every(
        (finding) =>
          ![
            "tool_failed",
            "duplicate_tool_call",
            "tool_call_limit_risk",
          ].includes(finding.code),
      ),
  );
});
