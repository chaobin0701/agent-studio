import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
const source = await readFile(
  new URL("../../packages/chat-ui/src/client.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
new Function("require", "exports", "module", compiled)(
  createRequire(import.meta.url),
  module.exports,
  module,
);
const { createChatbotClient } = module.exports;
const pause = () => new Promise((r) => setTimeout(r, 20));
function fixture() {
  const sessions = [],
    calls = [],
    storage = new Map(),
    runId = randomUUID();
  let turns = [],
    failSend = false,
    complete = false,
    uploads = 0,
    interactions = [],
    eventListener,
    responseFailure;
  const pendingInteraction = () =>
    interactions.find((i) => i.status === "pending");
  const api = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path === "/options")
        return {
          agents: [
            {
              id: 1,
              name: "Published agent",
              version: 1,
              supportsImages: false,
            },
          ],
          canDelete: true,
          canRename: true,
        };
      if (method === "GET" && path.startsWith("/sessions?q="))
        return [...sessions];
      if (method === "POST" && path === "/sessions") {
        const s = { id: randomUUID(), title: "New", agentId: 1 };
        sessions.push(s);
        return s;
      }
      if (method === "POST" && path.endsWith("/messages")) {
        if (failSend)
          throw Object.assign(Error("network uncertainty"), { status: 503 });
        turns = [
          {
            id: runId + ":user",
            role: "user",
            content: body.message,
            runId,
            requestId: body.requestId,
          },
          {
            id: runId + ":assistant",
            role: "assistant",
            content: "",
            runId,
            status: "running",
          },
        ];
        return { id: runId };
      }
      if (path.endsWith("/cancel")) {
        interactions = interactions.map((i) =>
          i.status === "pending" ? { ...i, status: "cancelled" } : i,
        );
        complete = true;
        return { ok: true };
      }
      if (method === "POST" && path.endsWith("/respond")) {
        if (responseFailure === "pending")
          throw Object.assign(Error("network uncertainty"), { status: 503 });
        interactions = interactions.map((i) =>
          i.id === body.interactionId
            ? {
                ...i,
                status:
                  body.kind === "approval"
                    ? body.decision === "approve"
                      ? "approved"
                      : "rejected"
                    : body.skip ? "skipped" : "answered",
                ...(body.kind === "question"
                  ? {
                      answer: body.skip ? { skipped: true } : body.optionId
                        ? { optionId: body.optionId }
                        : { text: body.text },
                    }
                  : {}),
              }
            : i,
        );
        if (responseFailure === "accepted")
          throw Object.assign(Error("lost acknowledgement"), { status: 503 });
        return { runId, replayed: false, stream: "/events" };
      }
      if (method === "GET" && path.includes("/runs/"))
        return {
          status: complete
            ? "completed"
            : pendingInteraction()
              ? "waiting"
              : "running",
          partialAnswer: "",
          interactions,
        };
      if (method === "GET" && path.startsWith("/sessions/"))
        return {
          session: sessions.find((s) => s.id === path.split("/")[2]),
          messages: turns.map((t) => ({
            ...t,
            ...(t.role === "assistant"
              ? {
                  interactions,
                  status: pendingInteraction() ? "waiting" : t.status,
                }
              : {}),
            ...(complete && t.role === "assistant"
              ? { content: "Done", status: "completed" }
              : {}),
          })),
          activeRunId: turns.length && !complete ? runId : null,
          attachments: [],
        };
      throw Error("Unexpected fixture request " + path);
    },
    async events(_path, onEvent, signal) {
      eventListener = onEvent;
      if (pendingInteraction()) {
        onEvent("interaction_required", {
          runId,
          interaction: pendingInteraction(),
        });
        return;
      }
      if (complete) {
        onEvent("done", {});
        return;
      }
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    },
    async upload(_path, file) {
      uploads++;
      return {
        id: randomUUID(),
        name: file.name,
        size: file.size,
        mimeType: file.type,
        status: "ready",
      };
    },
    async download() {
      return new Blob(["file"]);
    },
  };
  return {
    api,
    sessions,
    calls,
    runId,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    setFail: (v) => {
      failSend = v;
    },
    finish: () => {
      complete = true;
    },
    uploads: () => uploads,
    waitFor: (kind = "question") => {
      const interaction = {
        id: randomUUID(),
        runId,
        kind,
        status: "pending",
        revision: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(kind === "question"
          ? {
              question: "你的预算是多少？",
              options: [
                { id: "budget-1", label: "2000 元以内" },
                { id: "budget-2", label: "2000–3000 元" },
              ],
              allowCustom: true,
            }
          : {
              toolName: "submit_request",
              description: "提交申请",
              arguments: { amount: 2499 },
            }),
      };
      interactions.push(interaction);
      eventListener?.("interaction_required", { runId, interaction });
      return interaction;
    },
    failResponse: (mode) => {
      responseFailure = mode;
    },
  };
}

test("formal chat creates one session, sends a strict payload and keeps explicit stop separate from view disposal", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "scope", f.storage);
  try {
    await c.initialize();
    c.draft("hello");
    await c.send();
    assert.equal(
      f.calls.filter((r) => r.method === "POST" && r.path === "/sessions")
        .length,
      1,
    );
    const post = f.calls.find((r) => r.path.endsWith("/messages"));
    assert.deepEqual(Object.keys(post.body).sort(), [
      "attachmentIds",
      "message",
      "requestId",
      "stream",
    ]);
    assert.equal(c.current().runId, f.runId);
    await c.cancel();
    assert.equal(f.calls.filter((r) => r.path.endsWith("/cancel")).length, 1);
    c.newConversation();
    assert.equal(c.current().messages.length, 0);
    assert.equal(c.state.activeId, null);
  } finally {
    c.dispose();
  }
  assert.equal(f.calls.filter((r) => r.path.endsWith("/cancel")).length, 1);
});
test("refresh restores owned history and a running task without resubmitting messages", async () => {
  const f = fixture(),
    first = createChatbotClient(f.api, "scope", f.storage);
  await first.initialize();
  first.draft("one");
  await first.send();
  first.dispose();
  const posts = f.calls.filter((r) => r.path.endsWith("/messages")).length;
  const recovered = createChatbotClient(f.api, "scope", f.storage);
  try {
    await recovered.initialize();
    assert.equal(recovered.current().runId, f.runId);
    assert.equal(
      f.calls.filter((r) => r.path.endsWith("/messages")).length,
      posts,
    );
  } finally {
    recovered.dispose();
  }
});
test("uncertain submission retains the original key and retries only after an explicit action, even after reload", async () => {
  const f = fixture(),
    first = createChatbotClient(f.api, "scope", f.storage);
  await first.initialize();
  first.draft("uncertain");
  f.setFail(true);
  await first.send();
  const original = f.calls.find((r) => r.path.endsWith("/messages")).body;
  assert.ok(first.current().pending);
  first.dispose();
  const c = createChatbotClient(f.api, "scope", f.storage);
  try {
    await c.initialize();
    assert.ok(c.current().pending);
    assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
    await c.send();
    assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
    f.setFail(false);
    await c.retryPending();
    assert.deepEqual(
      f.calls.filter((r) => r.path.endsWith("/messages"))[1].body,
      original,
    );
  } finally {
    c.dispose();
  }
});
test("uploads use actual API metadata, disallow unsupported images and keep failed files removable", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "scope", f.storage);
  try {
    await c.initialize();
    await c.upload([new File(["png"], "test.png", { type: "image/png" })]);
    assert.equal(f.uploads(), 0);
    await c.upload([
      new File(["# Notes"], "notes.md", { type: "text/markdown" }),
    ]);
    assert.equal(f.uploads(), 1);
    assert.equal(c.current().attachments[0].status, "ready");
    c.removeAttachment(c.current().attachments[0].id);
    assert.equal(c.current().attachments.length, 0);
  } finally {
    c.dispose();
  }
});

test("Enter submission clears draft once and concurrent sends do not create duplicate messages", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "dedupe", f.storage);
  try {
    await c.initialize();
    c.draft("one Enter");
    await Promise.all([c.send(), c.send(), c.send()]);
    assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
    assert.equal(c.current().draft, "");
    assert.equal(f.storage.getItem("dedupe:draft:" + c.state.activeId), null);
  } finally {
    c.dispose();
  }
});
test("invalid attachments do not create empty conversations; image capability refresh preserves draft", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "images", f.storage);
  try {
    await c.initialize();
    c.draft("keep my text");
    await c.upload([new File(["x"], "invalid.exe")]);
    assert.equal(f.sessions.length, 0);
    await c.upload([new File(["x"], "image.png", { type: "image/png" })]);
    assert.equal(f.sessions.length, 0);
    const request = f.api.request;
    f.api.request = async (method, path, body) =>
      path === "/options"
        ? {
            agents: [
              { id: 1, name: "Published", version: 2, supportsImages: true },
            ],
            canDelete: true,
            canRename: true,
          }
        : request(method, path, body);
    await c.refreshCapabilities();
    assert.equal(c.current().draft, "keep my text");
    f.api.download = async () =>
      new Blob(["normalized jpeg"], { type: "image/jpeg" });
    await c.upload([new File(["x"], "image.png", { type: "image/png" })]);
    await pause();
    assert.equal(f.uploads(), 1);
    assert.ok(c.current().attachments[0].previewUrl?.startsWith("blob:"));
    assert.equal(c.current().draft, "keep my text");
  } finally {
    c.dispose();
  }
});
test("XSender replacement clears instead of inserting and restores session drafts without duplication", async () => {
  const src = await readFile(
    new URL("../../packages/chat-ui/src/sender-sync.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", compiled)(mod.exports);
  let text = "sent",
    replacements = 0;
  const sender = {
    getModelValue: () => ({ text }),
    getSender: () => ({
      reset: async ({ chatNode, clearHistory }) => {
        assert.equal(clearHistory, true);
        text = chatNode
          .map((row) => row.map((n) => n.text).join(""))
          .join("\n");
        replacements++;
      },
    }),
  };
  await mod.exports.replaceSenderText(sender, "");
  assert.equal(text, "");
  await mod.exports.replaceSenderText(sender, "saved\ndraft");
  await mod.exports.replaceSenderText(sender, "saved\ndraft");
  assert.equal(text, "saved\ndraft");
  assert.equal(replacements, 2);
});

test("waiting SSE retains the active task, restores its card after reload and does not resend a normal message", async () => {
  const f = fixture(),
    first = createChatbotClient(f.api, "waiting", f.storage);
  await first.initialize();
  first.draft("help me choose");
  await first.send();
  const question = f.waitFor();
  await pause();
  assert.equal(first.current().runStatus, "waiting");
  assert.equal(first.current().runId, f.runId);
  assert.equal(first.current().messages.at(-1).interactions[0].id, question.id);
  first.draft("keep this draft");
  await first.send();
  assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
  const reads = f.calls.filter((r) => r.path.includes("/runs/")).length;
  await pause();
  assert.equal(f.calls.filter((r) => r.path.includes("/runs/")).length, reads);
  first.dispose();
  const recovered = createChatbotClient(f.api, "waiting", f.storage);
  try {
    await recovered.initialize();
    assert.equal(recovered.current().runStatus, "waiting");
    assert.equal(recovered.current().draft, "keep this draft");
    await recovered.respond({
      kind: "question",
      interactionId: question.id,
      revision: 1,
      optionId: "budget-2",
    });
    const post = f.calls.find((r) => r.path.endsWith("/respond"));
    assert.deepEqual(post.body, {
      kind: "question",
      interactionId: question.id,
      revision: 1,
      optionId: "budget-2",
    });
    assert.equal(recovered.current().runStatus, "running");
    assert.equal(
      recovered.current().messages.at(-1).interactions[0].status,
      "answered",
    );
    assert.equal(recovered.current().draft, "keep this draft");
  } finally {
    recovered.dispose();
  }
});

test("approval submits only its bound decision, deduplicates clicks and retains the historical result", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "approval", f.storage);
  try {
    await c.initialize();
    c.draft("submit");
    await c.send();
    const approval = f.waitFor("approval");
    await pause();
    const response = {
      kind: "approval",
      interactionId: approval.id,
      revision: 1,
      decision: "approve",
      arguments: { amount: 1 },
      approvedTools: ["anything"],
    };
    await Promise.all([c.respond(response), c.respond(response)]);
    const posts = f.calls.filter((r) => r.path.endsWith("/respond"));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      kind: "approval",
      interactionId: approval.id,
      revision: 1,
      decision: "approve",
    });
    assert.equal(
      c.current().messages.at(-1).interactions[0].status,
      "approved",
    );
    assert.equal(
      c.current().messages.at(-1).interactions[0].arguments.amount,
      2499,
    );
    await c.respond(response);
    assert.equal(f.calls.filter((r) => r.path.endsWith("/respond")).length, 1);
  } finally {
    c.dispose();
  }
});

test("skip continues the original task and preserves the unsent draft instead of cancelling", async () => {
  const f=fixture(),c=createChatbotClient(f.api,'skip',f.storage);
  try {
    await c.initialize();c.draft('ask me first');await c.send();
    const question=f.waitFor();await pause();
    c.draft('keep this unsent draft');
    await c.respond({kind:'question',interactionId:question.id,revision:1,skip:true});
    assert.equal(c.current().runId,f.runId);
    assert.equal(c.current().runStatus,'running');
    assert.equal(c.current().draft,'keep this unsent draft');
    assert.equal(c.current().messages.at(-1).interactions[0].status,'skipped');
    assert.deepEqual(f.calls.find(call=>call.path.endsWith('/respond')).body,{kind:'question',interactionId:question.id,revision:1,skip:true});
    assert.equal(f.calls.some(call=>call.path.endsWith('/cancel')),false);
  } finally {c.dispose();}
});

test("uncertain interaction responses reconcile by GET and remain explicit without replaying tools or messages", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "uncertain-interaction", f.storage);
  try {
    await c.initialize();
    c.draft("choose");
    await c.send();
    const question = f.waitFor();
    await pause();
    f.failResponse("pending");
    const response = {
      kind: "question",
      interactionId: question.id,
      revision: 1,
      text: "2500 元",
    };
    await c.respond(response);
    assert.match(
      c.current().interactionErrors[question.id],
      /提交结果尚未确认/,
    );
    assert.equal(c.current().runStatus, "waiting");
    await pause();
    assert.equal(f.calls.filter((r) => r.path.endsWith("/respond")).length, 1);
    assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
    f.failResponse("accepted");
    await c.respond(response);
    assert.equal(
      c.current().messages.at(-1).interactions[0].status,
      "answered",
    );
    assert.equal(c.current().interactionErrors[question.id], undefined);
    assert.equal(
      c.current().messages.at(-1).interactions[0].answer.text,
      "2500 元",
    );
  } finally {
    c.dispose();
  }
});

test("only the active pending interaction can be answered and cancelling a waiting task updates history", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "isolation", f.storage);
  try {
    await c.initialize();
    c.draft("choose");
    await c.send();
    const question = f.waitFor();
    await pause();
    await c.respond({
      kind: "question",
      interactionId: randomUUID(),
      revision: 1,
      text: "forged",
    });
    await c.respond({
      kind: "question",
      interactionId: question.id,
      revision: 2,
      text: "stale",
    });
    await c.respond({
      kind: "question",
      interactionId: question.id,
      revision: 1,
      optionId: "unknown",
    });
    assert.equal(f.calls.filter((r) => r.path.endsWith("/respond")).length, 0);
    await c.cancel();
    assert.equal(
      c.current().messages.at(-1).interactions[0].status,
      "cancelled",
    );
    assert.equal(c.current().runId, null);
    c.newConversation();
    await c.respond({
      kind: "question",
      interactionId: question.id,
      revision: 1,
      text: "different session",
    });
    assert.equal(f.calls.filter((r) => r.path.endsWith("/respond")).length, 0);
  } finally {
    c.dispose();
  }
});

test("one task can ask a question and later request approval while preserving both cards", async () => {
  const f = fixture(),
    c = createChatbotClient(f.api, "sequential-interactions", f.storage);
  try {
    await c.initialize();
    c.draft("help and submit");
    await c.send();
    const question = f.waitFor();
    await pause();
    await c.respond({
      kind: "question",
      interactionId: question.id,
      revision: 1,
      optionId: "budget-1",
    });
    const approval = f.waitFor("approval");
    await pause();
    assert.equal(c.current().runStatus, "waiting");
    assert.equal(c.current().messages.at(-1).interactions.length, 2);
    await c.respond({
      kind: "approval",
      interactionId: approval.id,
      revision: 1,
      decision: "reject",
    });
    assert.deepEqual(
      c
        .current()
        .messages.at(-1)
        .interactions.map((i) => i.status),
      ["answered", "rejected"],
    );
    assert.equal(f.calls.filter((r) => r.path.endsWith("/messages")).length, 1);
    assert.equal(c.current().runStatus, "running");
  } finally {
    c.dispose();
  }
});
