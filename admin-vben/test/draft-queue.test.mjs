import test from "node:test";
import assert from "node:assert/strict";
import { createDraftQueue } from "../apps/web-ele/src/composables/draft-queue.ts";
import { groupManagementRoutes } from "../apps/web-ele/src/router/routes/navigation.ts";
function fixture(write) {
  let value = { identity: "a", revision: 1, payload: "one" },
    original = "";
  const states = [],
    accepted = [];
  const queue = createDraftQueue({
    delay: 60000,
    read: () => (value.payload !== original ? { ...value } : undefined),
    write,
    accept: (draft, result) => {
      accepted.push(draft);
      value.revision = result.revision;
      original = draft.payload;
    },
    state: (s) => states.push(s),
  });
  return {
    queue,
    states,
    accepted,
    get value() {
      return value;
    },
    set value(v) {
      value = v;
    },
    get original() {
      return original;
    },
  };
}
test("optimistic autosave serializes writes and never acknowledges edits made while saving", async () => {
  let release;
  const writes = [];
  const f = fixture(async (draft) => {
    writes.push({ ...draft });
    if (writes.length === 1) await new Promise((r) => (release = r));
    return { revision: draft.revision + 1 };
  });
  const save = f.queue.flush();
  await Promise.resolve();
  f.value.payload = "two";
  release();
  assert.equal(await save, true);
  assert.deepEqual(
    writes.map((w) => [w.payload, w.revision]),
    [
      ["one", 1],
      ["two", 2],
    ],
  );
  assert.equal(f.original, "two");
  assert.equal(f.value.revision, 3);
  f.queue.dispose();
});
test("conflicts stop automatic writes and preserve the buffer until explicit reload/reset", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw {
      response: { status: 409, data: { error: { message: "草稿已更新" } } },
    };
  });
  assert.equal(await f.queue.flush(), false);
  assert.equal(await f.queue.flush(), false);
  assert.equal(calls, 1);
  assert.equal(f.original, "");
  assert.equal(f.states.at(-1).conflict, true);
  f.queue.dispose();
});
test("transient failure permits explicit retry without losing edits or advancing revision", async () => {
  let calls = 0;
  const f = fixture(async (draft) => {
    if (++calls === 1) throw new Error("offline");
    return { revision: draft.revision + 1 };
  });
  assert.equal(await f.queue.flush(), false);
  assert.equal(f.value.revision, 1);
  assert.equal(await f.queue.flush(), true);
  assert.equal(f.value.revision, 2);
  f.queue.dispose();
});
test("a late response cannot update a switched or disposed resource", async () => {
  let release;
  const f = fixture(async () => {
    await new Promise((r) => (release = r));
    return { revision: 2 };
  });
  const save = f.queue.flush();
  await Promise.resolve();
  f.queue.reset();
  f.value = { identity: "b", revision: 7, payload: "new" };
  f.queue.dispose();
  release();
  assert.equal(await save, false);
  assert.equal(f.accepted.length, 0);
  assert.equal(f.value.revision, 7);
});
test("navigation groups preserve resource routes and authority, while records stay directly accessible", () => {
  const routes = [
    {
      path: "/agents",
      name: "AgentList",
      meta: { authority: ["agent_config.read"] },
    },
    { path: "/agents/:id", name: "AgentDetail", meta: { hideInMenu: true } },
    { path: "/prompts", name: "Prompts" },
    { path: "/models/llm", name: "LlmModels" },
    { path: "/system/users", name: "SystemUsers" },
    { path: "/executions", name: "ExecutionList" },
  ];
  const grouped = groupManagementRoutes(routes);
  assert.equal(
    grouped.find((r) => r.name === "AgentWorkspace").children[0],
    routes[0],
  );
  assert.deepEqual(
    grouped.find((r) => r.name === "AgentWorkspace").children[0].meta.authority,
    ["agent_config.read"],
  );
  assert.equal(
    grouped.find((r) => r.name === "AgentWorkspace").children[1].path,
    "/agents/:id",
  );
  assert.ok(grouped.includes(routes.at(-1)));
  assert.equal(
    grouped.find((r) => r.name === "ResourceWorkspace").children[0].path,
    "/prompts",
  );
});

test("flush restores the final buffer when edits are reverted during an earlier in-flight write", async () => {
  let release;
  const writes = [];
  const f = fixture(async (draft) => {
    writes.push(draft.payload);
    if (writes.length === 1) await new Promise((r) => (release = r));
    return { revision: draft.revision + 1 };
  });
  const save = f.queue.flush();
  await Promise.resolve();
  f.value.payload = "";
  release();
  assert.equal(await save, true);
  assert.deepEqual(writes, ["one", ""]);
  assert.equal(f.original, "");
  f.queue.dispose();
});
