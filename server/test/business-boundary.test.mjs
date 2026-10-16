import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppModule } from "../dist/app.module.js";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { SkillsModule } from "../dist/ai/skills/skills.module.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import { httpEndpointSchema } from "../dist/tool-management/tool-config.js";
import { httpRequest } from "../dist/tool-management/http-tool.js";
import {
  normalizeRequestContext,
  contextFingerprint,
  messageContext,
} from "../dist/chat/request-context.js";
import {
  normalizeResource,
  knowledgeResources,
  makeContextBlock,
} from "../dist/ai/context/context-contribution.js";
import { ContextMemoryService } from "../dist/chat/context-memory.service.js";

const hit = {
  chunkId: 1,
  documentId: 4,
  documentTitle: "Guide",
  originalFilename: "guide.md",
  headingPath: "",
  content: "Validated content",
  sourceStartLine: 1,
  sourceEndLine: 2,
  score: 1,
};
test("platform boots without a business module, seeded Agent or implicit business Skills", () => {
  assert.ok(
    !Reflect.getMetadata("imports", AppModule).some(
      (m) => m.name === "ProductsModule",
    ),
  );
  assert.equal(AgentManagementService.prototype.onModuleInit, undefined);
  assert.equal(SkillsModule.prototype.onModuleInit, undefined);
  assert.deepEqual(new SkillRegistry().list(), []);
  assert.deepEqual(DEFAULT_AGENT_CONFIGURATION.enabledSkills, []);
  assert.deepEqual(DEFAULT_AGENT_CONFIGURATION.runtime.allowedTools, [
    "search_knowledge",
    "load_skill",
  ]);
});
test("the current backend source has no embedded catalog, business renderer or privileged internal HTTP bypass", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );
  for (const path of walk(root))
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /ProductCatalogService|productResources|product-detail|productIds|productReferences|application\.internal|customer_support|default_support/,
      path,
    );
});
test("HTTP tools accept ordinary versioned APIs and reject old privileged relative connections", () => {
  const endpoint = {
    url: "https://service.example/records/{id}",
    method: "GET",
    mappingMode: "explicit",
    bindings: [{ source: "id", location: "path", target: "id" }],
  };
  const parsed = httpEndpointSchema.parse(endpoint);
  assert.equal(
    httpRequest({ endpoint: parsed }, { id: "a/b" }).url.href,
    "https://service.example/records/a%2Fb",
  );
  assert.equal(
    httpEndpointSchema.safeParse({
      ...endpoint,
      connection: "application",
      url: "/api/tool-services/product-catalog/products",
    }).success,
    false,
  );
  assert.equal(
    httpEndpointSchema.safeParse({ ...endpoint, url: "/private" }).success,
    false,
  );
});
test("generic caller context is bounded, canonicalized and never accepts legacy business fields", () => {
  assert.deepEqual(
    normalizeRequestContext({
      data: { recordIds: ["r1"], flags: { verbose: false } },
    }),
    { data: { recordIds: ["r1"], flags: { verbose: false } } },
  );
  assert.equal(
    contextFingerprint({ data: { b: 1, a: 2 } }),
    contextFingerprint({ data: { a: 2, b: 1 } }),
  );
  assert.equal(contextFingerprint({}), "[]");
  assert.notEqual(
    contextFingerprint({ data: { recordId: "a" } }),
    contextFingerprint({ data: { recordId: "b" } }),
  );
  assert.throws(() => normalizeRequestContext({ productIds: ["r1"] }));
  assert.throws(() =>
    normalizeRequestContext({ data: { body: "x".repeat(8001) } }),
  );
  assert.throws(() =>
    normalizeRequestContext(JSON.parse('{"data":{"__proto__":{}}}')),
  );
  assert.deepEqual(messageContext({ productIds: ["old"] }), {});
});
test("only currently authorized and fresh knowledge is restored; old business payloads cannot become memory", async () => {
  const resources = knowledgeResources({
    success: true,
    content: "",
    data: { hits: [hit] },
  });
  const block = makeContextBlock(resources, {
    conversationId: "c1",
    source: "search_knowledge",
    origin: "model",
  });
  const search = { restoreEvidence: async (rows) => rows };
  const memory = new ContextMemoryService(search);
  const cfg = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  const value = await memory.restore("c1", [block], cfg);
  assert.equal(value.evidence.length, 1);
  await memory.validateResource(
    resources[0],
    cfg,
    new AbortController().signal,
  );
  search.restoreEvidence = async () => [];
  await assert.rejects(
    memory.validateResource(resources[0], cfg, new AbortController().signal),
  );
  assert.deepEqual((await memory.restore("c1", [block], cfg)).resources, []);
  cfg.runtime.allowedTools = [];
  search.restoreEvidence = async (rows) => rows;
  assert.deepEqual((await memory.restore("c1", [block], cfg)).resources, []);
  assert.equal(
    normalizeResource({ kind: "product", data: { id: "old" } }),
    undefined,
  );
});
