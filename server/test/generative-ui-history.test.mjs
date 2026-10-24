import assert from "node:assert/strict";
import test from "node:test";
import { AgentApiController } from "../dist/chat/agent-api.controller.js";
import { ConversationService } from "../dist/chat/conversation.service.js";
import { IntegrationChatGateway } from "../dist/chat/integration-chat.gateway.js";

const artifact = {
  id: "present-call:0", kind: "generative_ui", delivery: "immediate",
  data: {
    adapter: "assistant-ui", catalogVersion: "a".repeat(64),
    tree: { _type: "Fact", label: "Count", value: 3 }, fallbackText: "Count · 3",
  },
};
const contextUsage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

function historyFixture(callId) {
  const lookups = [];
  const database = {
    async query(sql, values) {
      if (sql.startsWith("UPDATE")) return { rows: [] };
      if (sql.startsWith("SELECT id, title, summary")) {
        assert.deepEqual(values, ["conversation-1", "owner-1"]);
        return { rows: [{ id: "conversation-1" }] };
      }
      assert.deepEqual(values, ["conversation-1"]);
      if (sql.includes("FROM conversation_messages")) return { rows: [
        { id: 1, role: "user", content: "Show count", artifacts: [] },
        {
          id: 2, role: "assistant", content: "Count is 3", refused: false,
          citations: [], structured: { followups: ["More?"] },
          artifacts: JSON.parse(JSON.stringify([artifact])), toolSteps: [{ internal: true }],
        },
        { id: 4, role: "assistant", content: "Plain answer", artifacts: [] },
      ] };
      if (sql.includes("FROM conversation_runs r")) {
        const links = [
          { messageId: 2, runId: "run-1", callId, contextUsage: callId ? contextUsage : null },
          { messageId: 4, runId: "run-2", callId: "call-2" },
        ];
        return { rows: sql.includes("r.integration_call_id IS NOT NULL")
          ? links.filter(link => link.callId !== null) : links };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const interaction = { id: "interaction-1", status: "completed" };
  const interactions = { async listMany(ids) {
    lookups.push(ids);
    return new Map(callId ? [[callId, [interaction]]] : []);
  } };
  const service = new ConversationService(
    database, {}, {}, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, interactions,
  );
  const identity = { kind: "api" };
  const access = {
    assertScope(actual, scope) {
      assert.equal(actual, identity);
      assert.equal(scope, "conversations:read");
    },
    async platformOwner(actual, userId) {
      assert.equal(actual, identity);
      assert.equal(userId, "visitor-1");
      return "owner-1";
    },
  };
  const controller = new AgentApiController(access, service, {}, {});
  return { controller, service, database, lookups, interaction, request: { integration: identity } };
}

for (const callId of ["call-1", null]) {
  test(`public history restores completed UI with stable done identifiers (integration call: ${callId})`, async () => {
    const { controller, request, lookups, interaction } = historyFixture(callId);
    const messages = await controller.history(request, "conversation-1", "visitor-1");
    const assistant = messages[1];
    const done = new IntegrationChatGateway({}, {}, {}, {}).publicResult({
      conversationId: "conversation-1", runId: "run-1", status: "completed",
      answer: "Count is 3", refused: false, citations: [], artifacts: [artifact],
    });
    assert.deepEqual(assistant.uiBlocks, [{
      protocolVersion: 1, runId: "run-1", blockId: "run-1:present-call:0",
      toolCallId: "present-call", adapter: "assistant-ui", catalogVersion: "a".repeat(64),
      revision: 1, status: "completed", tree: artifact.data.tree, fallbackText: "Count · 3",
    }]);
    assert.deepEqual(assistant.uiBlocks, done.uiBlocks);
    assert.equal(assistant.status, "completed");
    assert.deepEqual(assistant.structured, { followups: ["More?"] });
    assert.deepEqual(assistant.interactions, callId ? [interaction] : []);
    assert.deepEqual(assistant.contextUsage, callId ? contextUsage : undefined);
    assert.equal("toolSteps" in assistant, false);
    assert.deepEqual(messages[0].uiBlocks, []);
    assert.deepEqual(messages[2].uiBlocks, []);
    assert.deepEqual(lookups, [callId ? [callId, "call-2"] : ["call-2"]]);
  });
}

test("public UI history still checks conversation ownership before reading messages or artifacts", async () => {
  const { controller, request, database, lookups } = historyFixture(null);
  database.query = async (sql) => {
    if (sql.startsWith("UPDATE") || sql.startsWith("SELECT id, title, summary")) return { rows: [] };
    assert.fail("History data must not be read for an inaccessible conversation");
  };
  await assert.rejects(controller.history(request, "conversation-1", "visitor-1"), error => error.getStatus() === 404);
  assert.deepEqual(lookups, []);
});
