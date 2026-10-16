import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript");
const { ref } = require("vue");
const {
  createMemoryHistory,
  createRouter,
  isNavigationFailure,
  NavigationFailureType,
} = require("vue-router");
const source = readFileSync(
  new URL("../apps/web-ele/src/layouts/basic.vue", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(
  source.slice(
    source.indexOf("const switchPending"),
    source.indexOf("const name"),
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

async function fixture(path = "/overview") {
  const events = [],
    notices = [];
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ["/overview", "/models/embedding", "/auth/login"].map((path) => ({
      path,
      component: {},
    })),
  });
  await router.push(path);
  const workspace = {
    id: 1,
    generation: 0,
    switching: false,
    items: [
      { id: 1, enabled: true },
      { id: 2, enabled: true },
    ],
    async refresh() {
      events.push("refresh");
    },
    select(value) {
      this.id = value;
      this.generation++;
      events.push(`select:${value}`);
    },
  };
  const authStore = {
    async fetchUserInfo() {
      events.push(`identity:${workspace.id}`);
    },
  };
  const context = {
    ref,
    router,
    isNavigationFailure,
    NavigationFailureType,
    workspace,
    authStore,
    ElMessage: { error: (message) => notices.push(message) },
    location: { reload: () => events.push("reload") },
  };
  runInNewContext(
    `${compiled}\nglobalThis.page = { switchWorkspace, switchPending };`,
    context,
  );
  return { ...context, events, notices, page: context.page };
}

for (const path of ["/models/embedding", "/overview"]) {
  test(`workspace switches from ${path}, including duplicated overview navigation, and reloads only once`, async () => {
    const f = await fixture(path);
    await f.page.switchWorkspace(2);
    assert.deepEqual(f.events, ["refresh", "select:2", "identity:2", "reload"]);
    assert.equal(f.workspace.id, 2);
    assert.equal(f.router.currentRoute.value.path, "/overview");
    assert.equal(f.notices.length, 0);
  });
}

test("cancelling the unsaved-edit leave guard never changes workspace or reloads", async () => {
  const f = await fixture("/models/embedding");
  f.router.beforeEach(() => false);
  await f.page.switchWorkspace(2);
  assert.equal(f.workspace.id, 1);
  assert.equal(f.page.switchPending.value, false);
  assert.deepEqual(f.events, []);
  assert.equal(f.notices.length, 0);
});

test("a login redirect does not switch workspace", async () => {
  const f = await fixture("/models/embedding");
  f.router.beforeEach((to) => (to.path === "/overview" ? "/auth/login" : true));
  await f.page.switchWorkspace(2);
  assert.equal(f.workspace.id, 1);
  assert.deepEqual(f.events, []);
});

test("repeated selection is locked before the first asynchronous operation", async () => {
  const f = await fixture("/models/embedding");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.router.beforeEach(() => gate);
  const first = f.page.switchWorkspace(2);
  assert.equal(f.page.switchPending.value, true);
  await f.page.switchWorkspace(2);
  release(true);
  await first;
  assert.deepEqual(f.events, ["refresh", "select:2", "identity:2", "reload"]);
});

test("a newly disabled or removed workspace cannot be selected", async () => {
  for (const items of [[{ id: 2, enabled: false }], []]) {
    const f = await fixture();
    f.workspace.refresh = async () => {
      f.workspace.items = items;
    };
    await f.page.switchWorkspace(2);
    assert.equal(f.workspace.id, 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.notices.length, 1);
    assert.equal(f.page.switchPending.value, false);
  }
});

test("identity request failure restores the old workspace and allows a retry", async () => {
  const f = await fixture();
  f.authStore.fetchUserInfo = async () => {
    throw new Error("Unavailable");
  };
  await f.page.switchWorkspace(2);
  assert.deepEqual(f.events, ["refresh", "select:2", "select:1"]);
  assert.equal(f.workspace.id, 1);
  assert.equal(f.workspace.switching, false);
  assert.equal(f.page.switchPending.value, false);
  assert.equal(f.notices.length, 1);
  f.authStore.fetchUserInfo = async () => {};
  await f.page.switchWorkspace(2);
  assert.equal(f.workspace.id, 2);
  assert.equal(f.events.filter((event) => event === "reload").length, 1);
});

test("session expiry during switching never resurrects a cleared workspace", async () => {
  const f = await fixture();
  f.authStore.fetchUserInfo = async () => {
    f.workspace.id = undefined;
    throw new Error("Expired");
  };
  await f.page.switchWorkspace(2);
  assert.equal(f.workspace.id, undefined);
  assert.deepEqual(f.events, ["refresh", "select:2"]);
  assert.equal(f.workspace.switching, false);
});

test("selecting the current workspace does nothing", async () => {
  const f = await fixture();
  await f.page.switchWorkspace(1);
  assert.deepEqual(f.events, []);
});
