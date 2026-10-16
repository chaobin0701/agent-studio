import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../src/visitor-transport.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
new Function("exports", compiled)(module.exports);
const { createVisitorTransport } = module.exports;
test("neutral chat uses scoped visitor sessions, retains resume credentials and shares bootstrap", async () => {
  const calls = [],
    saved = new Map();
  const request = createVisitorTransport(
    "app-1",
    async (path, options) => {
      calls.push({ path, options });
      return Response.json(
        path === "/api/widget/session"
          ? {
              accessToken: "visitor-test",
              resumeToken: "resume-test",
              expiresIn: 900,
            }
          : { ok: true },
      );
    },
    {
      getItem: (k) => saved.get(k) ?? null,
      setItem: (k, v) => saved.set(k, v),
    },
  );
  await Promise.all([request("/bot/options"), request("/bot/sessions")]);
  assert.equal(calls.filter((c) => c.path === "/api/widget/session").length, 1);
  assert.equal(saved.get("agent-studio-visitor:app-1"), "resume-test");
  assert.ok(
    calls
      .filter((c) => c.path.startsWith("/api/chat"))
      .every(
        (c) => c.options.headers.get("Authorization") === "Bearer visitor-test",
      ),
  );
});
test("rejected submissions are not automatically repeated", async () => {
  let submits = 0;
  const request = createVisitorTransport("app-1", async (path) => {
    if (path === "/api/widget/session")
      return Response.json({
        accessToken: "visitor-test",
        resumeToken: "resume-test",
        expiresIn: 900,
      });
    submits++;
    return Response.json({ message: "已过期" }, { status: 401 });
  });
  await assert.rejects(request("/bot/sessions", { method: "POST" }), /已过期/);
  assert.equal(submits, 1);
});
