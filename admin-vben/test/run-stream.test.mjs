import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeEventStream,
  readStreamError,
} from "../apps/web-ele/src/api/event-stream.ts";
import {
  applyRunEvent,
  newRunState,
} from "../apps/web-ele/src/views/playground/run-state.ts";
const encode = new TextEncoder();
const frame = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const byteStream = (value) =>
  new ReadableStream({
    start(controller) {
      for (const byte of encode.encode(value))
        controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
test("split UTF-8/CRLF events, heartbeats, retry resets and final authority do not duplicate provisional answers", async () => {
  const state = newRunState();
  const result = {
    answer: "最终答案",
    runId: "run",
    traceId: "trace",
    status: "completed",
    artifacts: [],
    references: [],
    usage: { totalTokens: 15 },
  };
  const source =
    ": keepalive\n\n" +
    frame("run_started", { runId: "run", replayed: false }) +
    frame("answer_delta", { text: "旧片段" }) +
    frame("answer_reset", { text: "" }) +
    frame("answer_delta", { text: "临时" }) +
    frame("progress", {
      id: "member",
      stage: "tool",
      status: "running",
      text: "成员执行中",
      secret: "never-store",
    }) +
    frame("progress", {
      id: "member",
      stage: "tool",
      status: "completed",
      text: "成员完成",
      ok: true,
    }) +
    frame("retry_status", {
      message: "已恢复",
      state: "recovered",
      attempt: 2,
      maxAttempts: 4,
    }) +
    frame("done", result) +
    frame("answer_delta", { text: "不可追加" });
  await consumeEventStream(
    byteStream(source.replaceAll("\n", "\r\n")),
    (event) => applyRunEvent(state, event),
  );
  assert.equal(state.answer, "最终答案");
  assert.equal(state.result.usage.totalTokens, 15);
  assert.equal(state.activities.length, 1);
  assert.equal(state.activities[0].status, "completed");
  assert.equal(JSON.stringify(state).includes("never-store"), false);
  assert.equal(state.terminal, true);
});
test("partial close is not success, errors cannot become canonical answers and abort cancels without reconnect", async () => {
  const state = newRunState();
  await consumeEventStream(
    byteStream(frame("answer_delta", { text: "部分回答" })),
    (event) => applyRunEvent(state, event),
  );
  assert.equal(state.terminal, false);
  assert.equal(state.result, undefined);
  applyRunEvent(state, {
    event: "error",
    data: JSON.stringify({ message: "未完成", nativeState: "private" }),
  });
  assert.equal(state.error, "未完成");
  assert.equal(state.result, undefined);
  let cancelled = 0;
  const pending = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const control = new AbortController();
  const consume = consumeEventStream(
    pending,
    () => assert.fail("unexpected event"),
    control.signal,
  );
  control.abort();
  await assert.rejects(consume);
  await new Promise(setImmediate);
  assert.equal(cancelled, 1);
});
test("bounded JSON admission failures are readable while malformed and oversized bodies are discarded", async () => {
  assert.deepEqual(
    await readStreamError(byteStream('{"error":{"message":"配置已变更"}}')),
    { error: { message: "配置已变更" } },
  );
  assert.equal(
    await readStreamError(byteStream("<html>bad proxy</html>")),
    undefined,
  );
  const large = new ReadableStream({
    start(c) {
      c.enqueue(encode.encode("x".repeat(65537)));
      c.close();
    },
  });
  assert.equal(await readStreamError(large), undefined);
});

test('output validation errors expose bounded paths without retaining raw result payloads',()=>{
 const state=newRunState();applyRunEvent(state,{event:'error',data:JSON.stringify({code:'output_validation_failed',message:'校验失败',issues:[{path:'$.count',message:'字段类型不匹配',value:'PRIVATE_RESULT'}]})});
 assert.deepEqual(state.outputIssues,[{path:'$.count',message:'字段类型不匹配'}]);assert.equal(state.terminal,true);assert.equal(state.result,undefined);assert.doesNotMatch(JSON.stringify(state),/PRIVATE_RESULT/);
});
