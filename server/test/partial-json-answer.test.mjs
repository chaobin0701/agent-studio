import assert from "node:assert/strict";
import test from "node:test";
import { partialJsonAnswer } from "../dist/ai/deep-agents/partial-json-answer.js";

test("reads an answer from partial JSON without exposing the unfinished envelope", () => {
  assert.equal(partialJsonAnswer('{"answer":"Hello'), "Hello");
  assert.equal(partialJsonAnswer('{"answer":"Hello\\nworld'), "Hello\nworld");
  assert.equal(partialJsonAnswer('{"answer":"Hello","structured":{'), "Hello");
  assert.equal(partialJsonAnswer('{"structured":{"answer":"nested"'), undefined);
  assert.equal(partialJsonAnswer('{"answer":'), undefined);
});
