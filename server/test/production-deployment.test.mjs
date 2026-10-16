import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
test("independent deployment exposes only ingress and preserves persistent data", () => {
  const compose = source("compose.production.yml");
  assert.equal((compose.match(/\n\s+ports:/g) || []).length, 1);
  assert.match(compose, /name: agent-studio-production/);
  assert.match(compose, /EDGE_BIND_IP:-127\.0\.0\.1/);
  assert.match(compose, /env_file: \.env/);
  assert.match(compose, /service_completed_successfully/);
  assert.match(compose, /postgres_data:/);
  assert.match(compose, /uploads:/);
});
test("ingress preserves streaming and separates admin and neutral chat SPAs", () => {
  const caddy = source("deploy/Caddyfile");
  assert.match(caddy, /flush_interval -1/);
  assert.match(caddy, /reverse_proxy api:3020/);
  assert.match(caddy, /handle_path \/chat\/\*/);
  assert.equal(
    (caddy.match(/try_files \{path\} \/index.html/g) || []).length,
    2,
  );
  assert.doesNotMatch(source("deploy/edge.Dockerfile"), /COPY.*\.env/);
  assert.match(source(".dockerignore"), /\*\*\/\.env\*/);
});
test("independent repository excludes legacy sites and uses isolated identity namespaces", () => {
  assert.equal(existsSync(new URL("web", root)), false);
  assert.equal(existsSync(new URL("website", root)), false);
  assert.match(
    source("server/src/chat/conversation.service.ts"),
    /agent_studio_visitor/,
  );
  assert.match(
    source("server/src/workspaces/scoped-pool.ts"),
    /agent_studio_workspace_runtime/,
  );
  assert.match(
    source("admin-vben/apps/web-ele/src/main.ts"),
    /agent-studio-admin/,
  );
});
