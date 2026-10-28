import test from "node:test";
import assert from "node:assert/strict";
import { safeLangSmithLink } from "../../admin-vben/apps/web-ele/src/api/langsmith-link.ts";
const path =
  "/o/11111111-1111-4111-8111-111111111111/projects/p/22222222-2222-4222-8222-222222222222/r/33333333-3333-4333-8333-333333333333";
test("admin accepts LangSmith run routes and rejects executable, insecure, credential-bearing or arbitrary paths", () => {
  for (const origin of [
    "https://smith.langchain.com",
    "https://eu.smith.langchain.com",
    "https://tracing.example.com",
    "http://127.0.0.1:6006",
  ])
    assert.equal(safeLangSmithLink(origin + path), origin + path);
  for (const value of [
    null,
    "javascript:alert(1)",
    "http://public.example" + path,
    "https://user:secret@smith.langchain.com" + path,
    "https://smith.langchain.com" + path + "?key=secret",
    "https://smith.langchain.com/other",
  ])
    assert.equal(safeLangSmithLink(value), null);
});
