import assert from "node:assert/strict";
import test from "node:test";
import { ConversationService } from "../dist/chat/conversation.service.js";
import { BadGatewayException } from "@nestjs/common";
import { ModelFailure } from "../dist/chat/llm.service.js";

test("failed native Chat trace counts root/member/failed known usage once and preserves safe native classification", async () => {
  const statements = [];
  const db = {
    query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes("UPDATE conversations SET busy_until = now()"))
        return { rows: [{ busyUntil: "busy-native" }], rowCount: 1 };
      if (sql.includes("INSERT INTO conversation_runs"))
        return { rows: [{ id: "run-native" }] };
      return { rows: [] };
    },
  };
  const tokens = (total) => ({
    inputTokens: total - 1,
    outputTokens: 1,
    totalTokens: total,
  });
  const error = new ModelFailure(tokens(30), {
    errorCode: "provider_authentication",
    errorKind: "auth",
  });
  const context = {
    executionEngine: "deepagents",
    errorSummary: { phase: "deep_agent", errorCode: "provider_authentication" },
    modelCalls: [
      { ok: true, response: tokens(20) },
      { ok: false, response: tokens(30) },
    ],
    specialistTasks: [
      {
        totalTokens: 10,
        context: { modelCalls: [{ ok: true, response: tokens(10) }] },
      },
    ],
  };
  const service = new ConversationService(
    db,
    {
      askDetailed: async (_q, _h, _s, onContext) => {
        onContext(context);
        throw error;
      },
    },
    { model: "test" },
  );
  service.get = async () => ({ id: "conversation" });
  service.snapshot = async () => ({
    summary: "",
    history: [],
    agentTranscript: [],
    priorProducts: [],
    recentMessages: [],
  });
  await assert.rejects(
    service.ask(
      "owner",
      "conversation",
      "Task",
      undefined,
      undefined,
      "native-request",
    ),
    (failure) => failure === error,
  );
  const trace = statements.find((item) =>
    item.sql.includes("INSERT INTO chat_traces"),
  );
  assert.ok(trace.values.includes("provider_authentication"));
  assert.ok(trace.values.includes(57));
  assert.ok(trace.values.includes(3));
  assert.ok(trace.values.includes(60));
  assert.ok(
    !trace.values.includes(90),
    "failed current usage must not be added twice",
  );
});

test("protocol failures persist a failed trace/run, not an assistant refusal, and release the busy lock", async () => {
  const statements = [];
  const db = {
    query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes("UPDATE conversations SET busy_until = now()"))
        return { rows: [{ busyUntil: "busy-1" }], rowCount: 1 };
      if (sql.includes("INSERT INTO conversation_runs"))
        return { rows: [{ id: "run-1" }] };
      return { rows: [] };
    },
  };
  const error = new BadGatewayException({
    code: "model_protocol_error",
    message: "模型响应格式异常，请稍后重试。",
  });
  const service = new ConversationService(
    db,
    {
      askDetailed: async (_q, _h, _s, onContext) => {
        onContext({
          modelCalls: [
            {
              response: {
                inputTokens: 111,
                outputTokens: 222,
                totalTokens: 333,
              },
            },
          ],
        });
        throw error;
      },
    },
    { model: "test" },
  );
  service.get = async () => ({ id: "conversation" });
  service.snapshot = async () => ({
    summary: "",
    history: [],
    agentTranscript: [],
    priorProducts: [],
    recentMessages: [],
  });
  await assert.rejects(
    service.ask(
      "owner",
      "conversation",
      "介绍产品",
      undefined,
      undefined,
      "request-1",
    ),
    (failure) => failure === error,
  );
  const trace = statements.find((item) =>
    item.sql.includes("INSERT INTO chat_traces"),
  );
  assert.ok(trace);
  assert.ok(trace.values.includes("model_protocol_error"));
  assert.ok(trace.values.includes("failed"));
  for (const tokens of [111, 222, 333])
    assert.ok(trace.values.includes(tokens));
  assert.ok(
    !statements.some((item) =>
      item.sql.includes("INSERT INTO conversation_messages"),
    ),
  );
  assert.ok(
    statements.some((item) =>
      item.sql.startsWith("UPDATE conversations SET busy_until = NULL"),
    ),
  );
});

test("anonymous browser cookie resumes one identity without storing its plaintext token", async () => {
  const sessions = new Map();
  const database = {
    query: async (sql, values) => {
      if (sql.startsWith("SELECT id FROM visitor_sessions"))
        return {
          rows: sessions.has(values[0])
            ? [{ id: sessions.get(values[0]) }]
            : [],
        };
      if (sql.startsWith("INSERT INTO visitor_sessions")) {
        sessions.set(values[1], values[0]);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = new ConversationService(database, {}, {});
  const issued = [];
  const response = {
    cookie: (_name, value, options) => issued.push({ value, options }),
  };
  const first = await service.session({ headers: {}, secure: false }, response);
  const resumed = await service.session(
    {
      headers: { cookie: `agent_studio_visitor=${issued[0].value}` },
      secure: false,
    },
    response,
  );
  const second = await service.session(
    { headers: {}, secure: false },
    response,
  );
  assert.equal(first, resumed);
  assert.notEqual(first, second);
  assert.equal(issued.length, 2);
  assert.equal(issued[0].options.httpOnly, true);
  assert.equal(issued[0].options.sameSite, "lax");
  assert.ok(!sessions.has(issued[0].value));
});

test("conversation lookup does not reveal another browser identity", async () => {
  const service = new ConversationService(
    { query: async () => ({ rows: [] }) },
    {},
    {},
  );
  await assert.rejects(
    () => service.get("different-browser", "conversation-id"),
    (error) => error.getStatus() === 404,
  );
});

test("conversation snapshot keeps summary and recent history inside one conversation boundary", async () => {
  const database = {
    query: async (sql, values) => {
      if (sql.startsWith("SELECT id, title, summary")) {
        if (values[1] !== "browser-a") return { rows: [] };
        return {
          rows: [
            {
              id: values[0],
              title: "暖风机",
              summary: "用户正在比较 H1 和 H2。",
              summaryThroughMessageId: 2,
              createdAt: "now",
              updatedAt: "now",
            },
          ],
        };
      }
      if (sql.startsWith("SELECT id::int, role, content")) {
        return {
          rows: [
            {
              id: 4,
              role: "assistant",
              content: "H2 的额定功率是 1500 W。",
              refused: false,
            },
            { id: 3, role: "user", content: "H2 有多大功率？", refused: null },
          ],
        };
      }
      if (sql.includes("context_snapshot->'agentTranscript'"))
        return {
          rows: [
            {
              agentTranscript: [
                {
                  conversationId: "conversation-a",
                  traceId: "trace-1",
                  sequence: 1,
                  createdAt: "2026-09-29T00:00:00.000Z",
                  role: "assistant",
                  content: "上一轮回答",
                },
              ],
            },
          ],
        };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = new ConversationService(database, {}, {});
  const snapshot = await service.snapshot("browser-a", "conversation-a");
  assert.equal(snapshot.conversationId, "conversation-a");
  assert.equal(snapshot.summary, "用户正在比较 H1 和 H2。");
  assert.deepEqual(snapshot.history, [
    { question: "H2 有多大功率？", answer: "H2 的额定功率是 1500 W。" },
  ]);
  assert.equal(snapshot.agentTranscript[0].traceId, "trace-1");
  await assert.rejects(
    () => service.snapshot("browser-b", "conversation-a"),
    (error) => error.getStatus() === 404,
  );
});

test("an expired run cannot persist a late answer", async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      if (
        sql.includes("FROM conversation_runs") &&
        sql.includes("status = 'running'")
      )
        return { rows: [] };
      throw new Error(`Unexpected query after expired run guard: ${sql}`);
    },
  };
  const database = { transaction: async (callback) => callback(client) };
  const service = new ConversationService(
    database,
    {},
    { model: "test-model" },
  );
  await assert.rejects(
    () =>
      service.saveResult?.(
        "conversation-a",
        "晚到的问题",
        {
          result: { answer: "不应保存", refused: false, citations: [] },
          contextSnapshot: {},
          rawModelOutput: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        10,
        "run-a",
      ),
    (error) => error.getStatus() === 409,
  );
  assert.equal(statements.length, 1);
});

test("conversation releases the exact database busy lock after a completed answer", async () => {
  const exactBusyUntil = "2026-09-24 07:47:49.414861+00";
  let releasedBusyUntil = null;
  const database = {
    query: async (sql, values = []) => {
      if (sql.includes("UPDATE conversation_runs r SET status"))
        return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE conversations SET busy_until = now()")) {
        assert.match(sql, /busy_until::text AS "busyUntil"/);
        return {
          rows: [{ id: "conversation-a", busyUntil: exactBusyUntil }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT id, title, summary")) {
        return {
          rows: [
            {
              id: "conversation-a",
              title: "新对话",
              summary: "",
              summaryThroughMessageId: null,
              createdAt: "now",
              updatedAt: "now",
            },
          ],
        };
      }
      if (sql.startsWith("SELECT id::int, role, content")) return { rows: [] };
      if (sql.includes("context_snapshot->'agentTranscript'"))
        return { rows: [] };
      if (sql.startsWith("UPDATE conversations SET busy_until = NULL")) {
        releasedBusyUntil = values[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT summary_through_message_id"))
        return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    transaction: async (work) =>
      work({
        query: async (sql) => {
          if (
            sql.startsWith("INSERT INTO conversation_messages") &&
            sql.includes("'user'")
          )
            return { rows: [{ id: 1 }] };
          if (
            sql.startsWith("INSERT INTO conversation_messages") &&
            sql.includes("'assistant'")
          )
            return { rows: [{ id: 2 }] };
          return { rows: [], rowCount: 1 };
        },
      }),
  };
  const chat = {
    askDetailed: async () => ({
      result: {
        answer: "你好，有什么可以帮你？",
        refused: false,
        citations: [],
      },
      contextSnapshot: {},
      rawModelOutput: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }),
  };
  const service = new ConversationService(database, chat, {
    model: "test-model",
  });

  const answer = await service.ask("browser-a", "conversation-a", "你好啊");

  assert.equal(answer.refused, false);
  assert.equal(releasedBusyUntil, exactBusyUntil);
});

test("summary uses code-owned instructions even if a captured snapshot contains a managed summary", async () => {
  const { DEFAULT_SUMMARY_INSTRUCTIONS } = await import(
    "../dist/config/agent-config.js"
  );
  let actualPrompt = null,
    trace = null;
  const database = {
    query: async (sql) =>
      sql.startsWith("SELECT summary_through_message_id")
        ? { rows: [{ summaryThroughMessageId: 0 }] }
        : {
            rows: Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              role: i % 2 ? "assistant" : "user",
              content: "核实过的资料",
            })),
          },
    transaction: async (work) =>
      work({
        query: async (sql, values) => {
          if (sql.includes("INSERT INTO chat_traces"))
            trace = JSON.parse(values[2]);
          return { rows: [], rowCount: 1 };
        },
      }),
  };
  const llm = {
    model: "fixture",
    contextWindowTokens: 32000,
    completeDetailed: async (prompt) => {
      actualPrompt = prompt;
      return {
        model: "fixture",
        content: "摘要",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
    },
  };
  const promptRuntime = {
    render: () => {
      throw Error("summary must not render managed Prompts");
    },
    metadata: () => ({}),
  };
  const service = new ConversationService(
    database,
    {},
    llm,
    undefined,
    undefined,
    undefined,
    undefined,
    promptRuntime,
  );
  await service.updateSummary("conversation", "", undefined, {
    environment: "dev",
    prompts: { "conversation.summary": { template: "不应被采用" } },
  });
  assert.equal(actualPrompt, DEFAULT_SUMMARY_INSTRUCTIONS);
  assert.equal(trace.promptVersion, "conversation-summary-v1");
});
