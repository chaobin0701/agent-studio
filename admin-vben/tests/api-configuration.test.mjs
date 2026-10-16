import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript");
const axios = createRequire(
  new URL("../packages/effects/request/package.json", import.meta.url),
)("axios");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

// Use the actual Vben config reader, app RequestClient construction and login
// function. Only the client transport/stores are replaced; no browser needed.
function loginRequest({ apiURL, production = false } = {}) {
  const hooks = {
    exports: {},
    window: { _VBEN_ADMIN_PRO_APP_CONF_: { VITE_GLOB_API_URL: apiURL } },
  };
  runInNewContext(
    transpile(read("../packages/effects/hooks/src/use-app-config.ts")),
    hooks,
  );
  let request;
  class RequestClient {
    constructor(options) {
      this.options = options;
    }
    addRequestInterceptor() {}
    addResponseInterceptor() {}
    post(url, data) {
      request = { url: axios.getUri({ ...this.options, url }), data };
      return Promise.resolve(request);
    }
  }
  const context = {
    exports: {},
    RequestClient,
    useAppConfig: hooks.exports.useAppConfig,
    useAccessStore: () => ({ accessToken: null }),
    useWorkspaceStore: () => ({ generation: 0 }),
    useAuthStore: () => ({}),
    ElMessage: { error() {} },
  };
  const env = { PROD: production, VITE_GLOB_API_URL: apiURL };
  const requestSource = read("../apps/web-ele/src/api/request.ts")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replaceAll("import.meta.env", JSON.stringify(env));
  runInNewContext(transpile(requestSource), context);
  context.requestClient = context.exports.requestClient;
  runInNewContext(
    transpile(
      read("../apps/web-ele/src/api/core/auth.ts").replace(
        /^import[\s\S]*?;\n/gm,
        "",
      ),
    ),
    context,
  );
  context.exports.loginApi({
    username: "test-user",
    password: "test-password",
  });
  return request;
}

test("fresh dev worktree without local env posts login to the admin API, not UI route", () => {
  for (const apiURL of [undefined, "", "   "]) {
    const request = loginRequest({ apiURL });
    assert.equal(request.url, "/api/admin/auth/login");
    assert.equal(request.data.email, "test-user");
    assert.equal(request.data.password, "test-password");
  }
});

test("production injected empty config has the same admin API default", () => {
  assert.equal(loginRequest({ production: true }).url, "/api/admin/auth/login");
});

test("explicit dev and production API URLs remain supported", () => {
  for (const production of [false, true]) {
    assert.equal(
      loginRequest({ production, apiURL: "/gateway/api/admin/" }).url,
      "/gateway/api/admin/auth/login",
    );
    assert.equal(
      loginRequest({
        production,
        apiURL: "https://admin.example.test/api/admin",
      }).url,
      "https://admin.example.test/api/admin/auth/login",
    );
  }
});
