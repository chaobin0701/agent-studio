import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
// Runtime is CommonJS. Match its conditional SDK export, not a second ESM class.
const { ChatOpenAI } = createRequire(import.meta.url)("@langchain/openai");
import { LangChainOpenAIProvider } from "../dist/ai/providers/langchain-openai.provider.js";
import { OpenAICompatibleProvider } from "../dist/ai/providers/openai-compatible.provider.js";
import {
  ProviderTimeoutError,
  ProviderInvalidResponseError,
  ProviderOutputTruncatedError,
  ProviderContentFilteredError,
  ProviderInvalidRequestError,
} from "../dist/ai/providers/provider-errors.js";
import { llmDeploymentSchema } from "../dist/model-management/model-management.types.js";
import { collectPhoenixSpans } from "./helpers/phoenix-collector.mjs";
import { PhoenixExecutionTracer } from "../dist/observability/execution-tracer.js";
import { LlmService } from "../dist/chat/llm.service.js";

const configuration = {
  apiKey: "fixture-key",
  baseUrl: "https://test.example.invalid/v1",
  model: "pinned-model",
  timeoutMs: 1000,
  maxOutputTokens: 800,
};
const request = {
  model: "pinned-model",
  messages: [{ role: "user", content: "Task" }],
};
const completion = (extra = {}) => ({
  id: "completion-one",
  model: "pinned-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Done" },
      finish_reason: "stop",
    },
  ],
  ...extra,
});
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
const response = (text) =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });

test("one standard ChatOpenAI implementation preserves pinned parameters/messages and disables both retry layers", async (t) => {
  assert.equal(
    OpenAICompatibleProvider,
    LangChainOpenAIProvider,
    "compatibility path is only an alias",
  );
  const p = new LangChainOpenAIProvider(configuration);
  const sdk = p.modelFor(request);
  assert.ok(sdk instanceof ChatOpenAI);
  assert.equal(sdk.caller.maxRetries, 0);
  assert.equal(sdk.completions.caller.maxRetries, 0);
  assert.equal(sdk.completions.clientConfig.maxRetries, 0);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(String(url), configuration.baseUrl + "/chat/completions");
    assert.equal(options.redirect, "error");
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer fixture-key",
    );
    const body = JSON.parse(options.body);
    assert.equal(body.model, "pinned-model");
    assert.equal(body.max_tokens, 321);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"],
    );
    assert.equal(body.messages[2].tool_calls[0].id, "native-id");
    assert.equal(body.messages[3].tool_call_id, "native-id");
    return Response.json(
      completion({
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
    );
  });
  const result = await p.chat({
    ...request,
    maxTokens: 321,
    temperature: 0.2,
    tools: [
      { name: "read", description: "Read", parameters: { type: "object" } },
    ],
    toolChoice: "required",
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: "Policy" },
      ...request.messages,
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "native-id", name: "read", arguments: { id: 1 } }],
      },
      { role: "tool", toolCallId: "native-id", content: "Result" },
    ],
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.usage, {
    inputTokens: 9,
    outputTokens: 2,
    totalTokens: 11,
  });
});

test("SDK failures/unsupported usage never retry invisibly, and unknown/zero usage are not conflated", async (t) => {
  let calls = 0;
  const p = new LangChainOpenAIProvider(configuration);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(
      { error: { message: "Unavailable" } },
      { status: 503 },
    );
  });
  await assert.rejects(p.chat(request));
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => Response.json(completion()));
  assert.deepEqual((await p.chat(request)).usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      completion({
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    ),
  );
  assert.deepEqual((await p.chat(request)).usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("native indexed tool deltas can start without argument text; SDK streaming does not fabricate IDs or usage", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    response(
      frame({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "native-1",
                  type: "function",
                  function: { name: "read" },
                },
              ],
            },
          },
        ],
      }) +
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"id":1}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }) +
        "data: [DONE]\n\n",
    ),
  );
  const events = [];
  for await (const event of new LangChainOpenAIProvider(configuration).stream(
    request,
  ))
    events.push(event);
  const deltas = events.filter((event) => event.type === "tool_call_delta");
  assert.equal(deltas[0].id, "native-1");
  assert.equal(deltas[0].argumentsDelta, undefined);
  assert.equal(deltas[1].argumentsDelta, '{"id":1}');
  assert.equal(events.at(-1).finishReason, "tool_calls");
  assert.equal(events.at(-1).usage.totalTokens, null);
});

test(
  "closing a pending SDK body stream aborts its HTTP signal and cancels the reader",
  { timeout: 5000 },
  async (t) => {
    let signal, body;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      signal = options.signal;
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              frame({
                choices: [{ delta: { role: "assistant", content: "First" } }],
              }),
            ),
          );
          signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const iterator = new LangChainOpenAIProvider(configuration)
      .stream(request)
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.delta, "First");
    await iterator.return();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(
      body.locked,
      false,
      "SDK must release its reader, not leave a background consumer",
    );
  },
);

test(
  "deployment deadline covers waiting on the stream body after headers, not only the fetch",
  { timeout: 5000 },
  async (t) => {
    let calls = 0,
      signal;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      calls++;
      signal = options.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    await assert.rejects(async () => {
      for await (const event of new LangChainOpenAIProvider({
        ...configuration,
        timeoutMs: 25,
      }).stream(request)) {
      }
    }, ProviderTimeoutError);
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  },
);

test("malformed tools and truncated/filtered schema results fail without repair or replay", async (t) => {
  let calls = 0;
  const p = new LangChainOpenAIProvider(configuration);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(
      completion({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "bad",
                  type: "function",
                  function: { name: "read", arguments: "{bad" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
  });
  await assert.rejects(p.chat(request), ProviderInvalidResponseError);
  assert.equal(calls, 1);
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "result",
      strict: true,
      schema: {
        type: "object",
        properties: { sum: { type: "integer" } },
        required: ["sum"],
        additionalProperties: false,
      },
    },
  };
  for (const [finish, expected] of [
    ["length", ProviderOutputTruncatedError],
    ["content_filter", ProviderContentFilteredError],
  ]) {
    calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json(
        completion({
          choices: [
            {
              message: { role: "assistant", content: '{"sum":3}' },
              finish_reason: finish,
            },
          ],
        }),
      );
    });
    await assert.rejects(p.chat({ ...request, responseFormat }), expected);
    assert.equal(calls, 1);
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "stream_options not supported by this model" } },
      { status: 400 },
    ),
  );
  await assert.rejects(
    p.chat(request),
    ProviderInvalidRequestError,
    "unsupported options are not a missing model",
  );
});

test("stream usage is a versioned deployment option, enabled for old configurations and preserved when disabled", () => {
  assert.equal(
    llmDeploymentSchema.parse({ model: "pinned-model" }).streamUsage,
    true,
  );
  assert.equal(
    llmDeploymentSchema.parse({ model: "pinned-model", streamUsage: false })
      .streamUsage,
    false,
  );
  assert.equal(
    llmDeploymentSchema.safeParse({
      model: "pinned-model",
      streamUsage: "false",
    }).success,
    false,
  );
});

test("malformed/duplicate native call identity and oversized transport bodies are rejected before any capability can run", async (t) => {
  const provider = new LangChainOpenAIProvider(configuration);
  let calls = 0;
  for (const tools of [
    [{ id: 1, type: "function", function: { name: "read", arguments: "{}" } }],
    [
      {
        id: "same",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
      {
        id: "same",
        type: "function",
        function: { name: "write", arguments: "{}" },
      },
    ],
  ]) {
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json(
        completion({
          choices: [
            {
              message: { role: "assistant", content: "", tool_calls: tools },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );
    });
    await assert.rejects(provider.chat(request), ProviderInvalidResponseError);
  }
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(
      completion({
        choices: [
          {
            message: {
              role: "assistant",
              content: "x".repeat(4 * 1024 * 1024 + 1),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await assert.rejects(provider.chat(request), ProviderInvalidResponseError);
  assert.equal(calls, 3, "no repair/fallback/retry inside the transport");
});

test("SDK reasoning fields/typed thought blocks are private while their token usage remains accounted", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      completion({
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "PRIVATE_REASONING",
              content: [
                { type: "text", thought: true, text: "PRIVATE_THOUGHT" },
                { type: "reasoning", text: "PRIVATE_REASONING_BLOCK" },
                { type: "text", text: "Public answer" },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 30,
          total_tokens: 32,
          completion_tokens_details: { reasoning_tokens: 28 },
        },
      }),
    ),
  );
  const result = await new LangChainOpenAIProvider(configuration).chat(request);
  assert.equal(result.content, "Public answer");
  assert.equal(result.usage.totalTokens, 32);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test("fresh SDK process suppresses ambient LangSmith/SDK logs/org/project/base URL without leaking prompts", () => {
  const code = `const assert=require('node:assert/strict');const {LangChainOpenAIProvider}=require('./dist/ai/providers/langchain-openai.provider.js');let calls=0;global.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://test.example.invalid/v1/chat/completions');const headers=new Headers(init.headers);assert.equal(headers.get('openai-organization'),null);assert.equal(headers.get('openai-project'),null);return Response.json({model:'fixture',choices:[{message:{role:'assistant',content:'PRIVATE_RESPONSE'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})};(async()=>{const provider=new LangChainOpenAIProvider({apiKey:'fixture-key',model:'fixture',baseUrl:'https://test.example.invalid/v1',timeoutMs:1000});await provider.chat({model:'fixture',messages:[{role:'user',content:'PRIVATE_PROMPT'}]});await new Promise(r=>setTimeout(r,500));assert.equal(calls,1);process.stdout.write('sdk-cloud-disabled')})();`;
  const output = execFileSync(process.execPath, ["-e", code], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      LANGSMITH_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      LANGSMITH_API_KEY: "fixture-key",
      OPENAI_LOG: "debug",
      OPENAI_BASE_URL: "https://must-not-contact.example.invalid/v1",
      OPENAI_ORG_ID: "PRIVATE_ORGANIZATION",
      OPENAI_PROJECT_ID: "PRIVATE_PROJECT",
    },
  });
  assert.equal(output, "sdk-cloud-disabled");
});

test("SDK generations retain one authoritative model span per HTTP attempt and record the real adapter version", async (t) => {
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "sdk-adapter-acceptance" },
      collectPhoenixSpans(spans),
    );
  const provider = new LangChainOpenAIProvider(configuration),
    llm = new LlmService(provider);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    if (JSON.parse(options.body).stream)
      return response(
        frame({
          choices: [
            {
              delta: { role: "assistant", content: "PRIVATE_SDK_OUTPUT" },
              finish_reason: "stop",
            },
          ],
        }) +
          frame({
            choices: [],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }) +
          "data: [DONE]\n\n",
      );
    return Response.json(
      completion({
        choices: [
          {
            message: { role: "assistant", content: "PRIVATE_SDK_OUTPUT" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );
  });
  try {
    await tracer.span(
      "sdk_adapter_acceptance",
      "chain",
      { localRunId: "sdk-version-fixture" },
      async () => {
        await llm.completeDetailed(
          "PRIVATE_SDK_PROMPT",
          "PRIVATE_SDK_TASK",
          undefined,
          "planner",
          { maxRetries: 0 },
        );
        await llm.streamDetailed(
          "PRIVATE_SDK_PROMPT",
          "PRIVATE_SDK_TASK",
          undefined,
          "planner",
          { maxRetries: 0 },
        );
      },
    );
    assert.equal(await tracer.flush(), true);
    assert.equal(calls, 2);
    const models = spans.filter((span) => span.name === "model_attempt");
    assert.equal(
      models.length,
      2,
      "SDK/framework callback chains must not create duplicate billable LLM spans",
    );
    assert.ok(
      models.every(
        (span) =>
          span.metadata.modelAdapterVersion ===
          "langchain-openai-1.6.2/platform-v1",
      ),
    );
    assert.ok(models.every((span) => span.metadata.totalTokens === 3));
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|apiKey|authorization|input\.value|output\.value/,
    );
  } finally {
    await tracer.close();
  }
});

test("host-validated image input reaches the SDK wire without native message mutation or body tracing", async (t) => {
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "image-acceptance" },
      collectPhoenixSpans(spans),
    );
  const image = {
    id: "image-fixture",
    mimeType: "image/jpeg",
    data: Buffer.from("PRIVATE_IMAGE_BYTES"),
    width: 512,
    height: 512,
  };
  const images = [image],
    input = { ...request, images };
  const original = JSON.stringify(input.messages);
  await assert.rejects(
    new LangChainOpenAIProvider(configuration).chat(input),
    ProviderInvalidRequestError,
  );
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[0].text, "Task");
    assert.equal(
      body.messages[0].content[1].image_url.url,
      "data:image/jpeg;base64," + image.data.toString("base64"),
    );
    return Response.json(
      completion({
        usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
      }),
    );
  });
  try {
    const llm = new LlmService(
      new LangChainOpenAIProvider({
        ...configuration,
        supportsImageInput: true,
      }),
    );
    await tracer.span("image_input", "chain", {}, () =>
      llm.completeDetailed("", "", undefined, "planner", {
        messages: input.messages,
        images,
        maxRetries: 0,
      }),
    );
    await tracer.flush();
    assert.equal(original, JSON.stringify(input.messages));
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_IMAGE|data:image|base64|input\.value|output\.value/,
    );
  } finally {
    await tracer.close();
  }
});
