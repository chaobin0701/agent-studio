import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toolSchema } from "../dist/agent-management/resource.types.js";
import { makeManagedTool } from "../dist/agent-management/managed-tool.js";
import { httpRequest } from "../dist/tool-management/http-tool.js";
import {
  publicAddress,
  assertToolUrl,
  toolFetch,
  redactToolData,
} from "../dist/tool-management/network.js";
import {
  discoverMcp,
  withRemoteMcp,
  callMcp,
  contractHash,
  mcpResourceKey,
} from "../dist/tool-management/remote-mcp.js";
import { credentialSchema } from "../dist/tool-management/tool-config.js";
import { ToolManagementService } from "../dist/tool-management/tool-management.service.js";

const config = () =>
  toolSchema.parse({
    type: "rest",
    description: "HTTP fixture",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        limit: { type: "integer" },
        name: { type: "string" },
      },
      required: ["order_id"],
    },
    endpoint: {
      url: "https://example.com/orders/{order_id}",
      method: "POST",
      mappingMode: "explicit",
      bindings: [
        { source: "order_id", location: "path", target: "order_id" },
        { source: "limit", location: "query", target: "limit" },
        { source: "name", location: "body", target: "customer.name" },
      ],
    },
    readOnly: false,
    maxRetries: 0,
  });
const context = () => ({
  traceId: "fixture",
  permissions: [],
  state: new Map(),
  approvedTools: ["fixture"],
});

test("HTTP maps path/query/header/nested body with escaping and supports legacy configuration", () => {
  const spec = config();
  spec.endpoint.bindings.push({
    source: "name",
    location: "header",
    target: "X-Customer",
  });
  const request = httpRequest(
    spec,
    { order_id: "a/b?x", limit: 5, name: "Alice" },
    { kind: "api_key", header: "X-API-Key", secret: "fixture-key" },
  );
  assert.equal(request.url.pathname, "/orders/a%2Fb%3Fx");
  assert.equal(request.url.searchParams.get("limit"), "5");
  assert.deepEqual(JSON.parse(request.body), { customer: { name: "Alice" } });
  assert.equal(request.headers["X-Customer"], "Alice");
  assert.equal(request.headers["X-API-Key"], "fixture-key");
  assert.throws(
    () => httpRequest(spec, { name: "Alice" }),
    /missing_tool_path_parameter/,
  );
  const legacy = toolSchema.parse({
    type: "rest",
    description: "legacy",
    parameters: { type: "object" },
    endpoint: { url: "https://example.com", method: "GET" },
  });
  assert.equal(
    httpRequest(legacy, { q: "a b" }).url.searchParams.get("q"),
    "a b",
  );
});

test("HTTP configuration rejects header injection, protected headers and prototype mappings", () => {
  for (const target of ["__proto__.polluted", "constructor.value"])
    assert.equal(
      toolSchema.safeParse({
        ...config(),
        endpoint: {
          ...config().endpoint,
          bindings: [{ source: "name", location: "body", target }],
        },
      }).success,
      false,
    );
  assert.equal(
    toolSchema.safeParse({
      ...config(),
      endpoint: { ...config().endpoint, headers: { Authorization: "secret" } },
    }).success,
    false,
  );
  assert.equal(
    toolSchema.safeParse({
      ...config(),
      endpoint: { ...config().endpoint, headers: { "X-API-Key": "secret" } },
    }).success,
    false,
  );
  assert.equal(
    credentialSchema.safeParse({
      name: "key",
      kind: "api_key",
      header: "Host",
      secret: "value",
    }).success,
    false,
  );
  const spec = config();
  spec.endpoint.bindings = [
    { source: "name", location: "header", target: "X-Customer" },
  ];
  spec.endpoint.url = "https://example.com";
  assert.throws(
    () => httpRequest(spec, { name: "a\r\nb" }),
    /invalid_tool_header/,
  );
});

test("HTTP tests and runtime receive safe diagnostics, extraction errors and output validation", async () => {
  const spec = config();
  spec.endpoint.resultPath = "data";
  spec.outputSchema = {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  };
  const v = { id: 1, key: "fixture", config: spec };
  let response = Response.json({ data: { id: 3, password: "private" } });
  const tool = makeManagedTool(
    v,
    () => {
      throw Error("not builtin");
    },
    { fetch: async () => response },
  );
  let result = await tool.execute({ order_id: "123" }, context());
  assert.equal(result.success, true);
  assert.equal(result.data.password, "[REDACTED]");
  response = Response.json({ data: { id: "wrong" } });
  assert.equal(
    (await tool.execute({ order_id: "123" }, context())).errorCode,
    "tool_output_invalid",
  );
  response = Response.json({ other: 1 });
  assert.equal(
    (await tool.execute({ order_id: "123" }, context())).errorCode,
    "tool_result_path_missing",
  );
  response = Response.json(
    { error: { message: "invalid model" }, token: "private" },
    { status: 400 },
  );
  result = await tool.execute({ order_id: "123" }, context());
  assert.equal(result.metadata.status, 400);
  assert.match(result.content, /invalid model/);
  assert.equal(result.content.includes("private"), false);
});

test("approval blocks external calls and credential values never reach model-facing content", async () => {
  const spec = config();
  spec.requiresApproval = true;
  spec.endpoint.credentialId = 5;
  let calls = 0;
  const tool = makeManagedTool(
    { id: 2, key: "fixture", config: spec },
    () => {},
    {
      credential: async () => ({
        kind: "bearer",
        header: "Authorization",
        secret: "fixture-secret",
      }),
      fetch: async (_url, request) => {
        calls++;
        assert.equal(request.headers.Authorization, "Bearer fixture-secret");
        return Response.json({ result: "fixture-secret" });
      },
    },
  );
  assert.equal(
    (
      await tool.execute(
        { order_id: "123" },
        { ...context(), approvedTools: [] },
      )
    ).errorCode,
    "tool_approval_required",
  );
  assert.equal(calls, 0);
  assert.equal(
    (await tool.execute({ order_id: "123" }, context())).content.includes(
      "fixture-secret",
    ),
    false,
  );
});

test("egress defaults block private/mapped addresses, unsafe protocols, URL secrets and redirects", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  for (const url of [
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "http://example.com",
    "https://example.com?access_token=secret",
  ])
    assert.throws(() => assertToolUrl(url));
  assert.equal(
    assertToolUrl("https://example.com/orders/{order_id}").hostname,
    "example.com",
  );
  assert.deepEqual(
    redactToolData({
      api_key: "x",
      nested: ["Bearer y"],
      text: '{"password":"private"}',
    }),
    {
      api_key: "[REDACTED]",
      nested: ["Bearer [REDACTED]"],
      text: '{"password":"[REDACTED]"}',
    },
  );
});

test("MCP discovery is atomic across pagination, rejects repeated cursors and generates collision-resistant keys", async () => {
  let calls = 0;
  const client = {
    listTools: async () =>
      ++calls === 1
        ? {
            tools: [{ name: "a", inputSchema: { type: "object" } }],
            nextCursor: "next",
          }
        : { tools: [{ name: "b", inputSchema: { type: "object" } }] },
  };
  assert.deepEqual(
    (await discoverMcp(client)).map((tool) => tool.name),
    ["a", "b"],
  );
  await assert.rejects(
    discoverMcp({
      listTools: async () => ({ tools: [], nextCursor: "repeat" }),
    }),
    /repeated_cursor/,
  );
  assert.notEqual(
    mcpResourceKey("service", "a.b"),
    mcpResourceKey("service", "a-b"),
  );
  assert.equal(contractHash({ a: 1, b: 2 }), contractHash({ b: 2, a: 1 }));
  const definition = {
    name: "a",
    description: "a",
    inputSchema: { type: "object" },
  };
  await assert.rejects(
    callMcp(
      {
        listTools: async () => ({
          tools: [
            {
              ...definition,
              inputSchema: { type: "object", required: ["new"] },
            },
          ],
        }),
        callTool: async () => {
          throw Error("must not execute");
        },
      },
      definition,
      {},
    ),
    /contract_changed/,
  );
});

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const prior = process.env.AGENT_TOOL_ALLOWED_HOSTS;
  process.env.AGENT_TOOL_ALLOWED_HOSTS = "127.0.0.1";
  t.after(async () => {
    if (prior === undefined) delete process.env.AGENT_TOOL_ALLOWED_HOSTS;
    else process.env.AGENT_TOOL_ALLOWED_HOSTS = prior;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("real HTTP transport pins allowed network addresses, returns diagnostics and blocks redirects", async (t) => {
  const base = await fixture(t, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254" });
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }
  });
  assert.deepEqual(
    await (await toolFetch(base, { signal: AbortSignal.timeout(2000) })).json(),
    { ok: true },
  );
  await assert.rejects(
    toolFetch(base + "/redirect", { signal: AbortSignal.timeout(2000) }),
    /重定向/,
  );
});

test("real MCP Streamable HTTP supports initialization, discovery and tool calls through the shared safe transport", async (t) => {
  const base = await fixture(t, async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool(
      "echo",
      { description: "echo fixture", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const parts = [];
    for await (const part of req) parts.push(part);
    await transport.handleRequest(
      req,
      res,
      JSON.parse(Buffer.concat(parts).toString()),
    );
  });
  const result = await withRemoteMcp(
    { url: base + "/mcp", credentialId: null, timeoutMs: 5000 },
    undefined,
    undefined,
    async (client) => {
      const catalog = await discoverMcp(client);
      assert.equal(catalog[0].name, "echo");
      return callMcp(client, catalog[0], { text: "hello" });
    },
  );
  assert.equal(result.content[0].text, "hello");
});

test("MCP remote contracts and disabled credentials remain scoped and cannot be manually replaced", async () => {
  const version = {
    id: 4,
    serverId: 1,
    version: 2,
    enabled: true,
    key: "service",
    config: {
      url: "https://example.com",
      timeoutMs: 30000,
      credentialId: null,
    },
    catalog: [{ name: "echo", inputSchema: { type: "object" } }],
  };
  const service = new ToolManagementService(
    { query: async () => ({ rows: [version] }) },
    {},
  );
  const spec = toolSchema.parse({
    type: "mcp",
    target: "echo",
    mcpVersionId: 4,
    description: "echo",
    parameters: { type: "object" },
  });
  await service.validateTool(spec);
  await assert.rejects(
    service.validateTool({
      ...spec,
      parameters: { type: "object", required: ["injected"] },
    }),
    (e) => e.getStatus() === 400,
  );
  const missing = new ToolManagementService(
    { query: async () => ({ rows: [] }) },
    {},
  );
  await assert.rejects(missing.credential(1), /unavailable/);
  await assert.rejects(
    missing.connectionVersion(4),
    (e) => e.getStatus() === 404,
  );
});
