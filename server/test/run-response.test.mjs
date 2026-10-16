import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runResponse } from "../dist/executions/run-response.js";
import { AgentPreviewController } from "../dist/executions/agent-preview.controller.js";
const response = () =>
  Object.assign(new EventEmitter(), {
    writableLength: 0,
    destroyed: false,
    writableEnded: false,
    body: "",
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    flushHeaders() {},
    write(value) {
      this.body += value;
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
    json(value) {
      this.result = value;
      this.end();
      return this;
    },
  });
const prepared = {
  input: { stream: true },
  admission: { callId: "run", cached: null },
};
test("formal and preview stream protocol projects only public events and authoritative output", async () => {
  const reply = response(),
    result = { answer: "final", runId: "run", artifacts: [] };
  const runs = {
    publicResult: (value) => value,
    async execute(_prepared, _signal, callbacks) {
      assert.equal(callbacks.onContext, undefined);
      callbacks.onAnswerDelta("old");
      callbacks.onAnswerReset("");
      callbacks.onAnswerDelta("new");
      callbacks.onProgress({
        id: "a",
        type: "progress",
        stage: "tool",
        status: "completed",
        text: "工具已完成",
        ok: true,
        rawModelOutput: "PRIVATE",
      });
      return result;
    },
  };
  await runResponse(runs, prepared, reply, new AbortController());
  assert.equal(
    reply.headers["Content-Type"],
    "text/event-stream; charset=utf-8",
  );
  assert.equal(reply.writableEnded, true);
  assert.match(reply.body, /event: answer_reset/);
  assert.equal(reply.body.includes("PRIVATE"), false);
  assert.equal((reply.body.match(/event: done/g) ?? []).length, 1);
  assert.equal(reply.body.includes('"ok":true'), true);
});
test("stream failures redact internals, cached results skip event callbacks and disconnected previews propagate cancellation", async () => {
  const reply = response();
  await runResponse(
    {
      async execute() {
        throw new Error("SECRET_PROVIDER_BODY");
      },
      publicResult: (value) => value,
    },
    prepared,
    reply,
    new AbortController(),
  );
  assert.match(reply.body, /event: error/);
  assert.equal(reply.body.includes("SECRET_PROVIDER_BODY"), false);
  assert.equal(reply.body.includes("event: done"), false);
  const replay = response();
  await runResponse(
    {
      async execute() {
        return { answer: "cached" };
      },
      publicResult: (value) => value,
    },
    { ...prepared, admission: { cached: { runId: "old" } } },
    replay,
    new AbortController(),
  );
  assert.match(replay.body, /"replayed":true/);
  assert.equal(replay.body.includes("event: answer_delta"), false);
  const disconnected = response();
  let observed;
  const runs = {
    async execute(_p, signal) {
      observed = signal;
      disconnected.emit("close");
      signal.throwIfAborted();
    },
    publicResult: (value) => value,
    async cancelAdmission() {},
  };
  const controller = new AgentPreviewController(
    { prepare: async () => prepared },
    runs,
    { runConcurrent: (_key, action) => action() },
  );
  await controller.execute({ admin: { id: 1 } }, {}, disconnected);
  assert.equal(observed.aborted, true);
  assert.equal(disconnected.listenerCount("close"), 0);
});
