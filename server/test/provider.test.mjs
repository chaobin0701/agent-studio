import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../dist/ai/providers/openai-compatible.provider.js";
import {
  ProviderAuthenticationError,
  ProviderInvalidRequestError,
  ProviderQuotaExhaustedError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnsupportedResponseFormatError,
} from "../dist/ai/providers/provider-errors.js";

// Real provider fixtures declare their HTTP media type; the SDK does not parse
// text/plain as a JSON completion. Do not normalize response data in this helper.
function providerResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type"))
    headers.set(
      "content-type",
      (typeof body === "string" && body.startsWith("data:")) ||
        body instanceof ReadableStream
        ? "text/event-stream"
        : "application/json",
    );
  return new Response(body, { ...init, headers });
}

test("stream requests usage, handles split/final frames and never overwrites usage with null", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).stream_options, {
      include_usage: true,
    });
    const text =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\ndata: [DONE]';
    const bytes = new TextEncoder().encode(text);
    return providerResponse(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7)
            controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
    );
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "fixture",
      baseUrl: "https://test.example.invalid",
      model: "test",
      timeoutMs: 1000,
    });
    const events = [];
    for await (const event of provider.stream({ model: "test", messages: [] }))
      events.push(event);
    assert.equal(events[0].delta, "你好");
    assert.deepEqual(events.at(-1).usage, {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream preserves native tools and assembles multiple indexed tool calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.tools[0].function.name, "get_product_detail");
    const text = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-a",
                  function: {
                    name: "get_product_detail",
                    arguments: '{"productId":"one"',
                  },
                },
                {
                  index: 1,
                  id: "call-b",
                  function: {
                    name: "get_product_detail",
                    arguments: '{"productId":"two"',
                  },
                },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                { index: 0, function: { arguments: "}" } },
                { index: 1, function: { arguments: "}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}`,
      "data: [DONE]",
    ].join("\n\n");
    return providerResponse(text);
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "fixture",
      baseUrl: "https://test.example.invalid",
      model: "test",
      timeoutMs: 1000,
    });
    const events = [];
    for await (const event of provider.stream({
      model: "test",
      messages: [],
      tools: [
        {
          name: "get_product_detail",
          description: "detail",
          parameters: { type: "object" },
        },
      ],
      responseFormat: { type: "json_object" },
    }))
      events.push(event);
    assert.deepEqual(
      events
        .filter((event) => event.type === "tool_call_delta")
        .map((event) => event.index),
      [0, 1, 0, 1],
    );
    assert.equal(events.at(-1).type, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unsupported stream usage fails after one accounted request; disabling usage is explicit and auth never retries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const config = {
    apiKey: "fixture",
    baseUrl: "https://test.example.invalid",
    model: "test",
    timeoutMs: 1000,
  };
  try {
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        { error: { message: "stream_options unsupported" } },
        { status: 400 },
      );
    };
    const provider = new OpenAICompatibleProvider(config);
    await assert.rejects(async () => {
      for await (const event of provider.stream({
        model: "test",
        messages: [],
      })) {
      }
    }, ProviderInvalidRequestError);
    assert.equal(
      calls,
      1,
      "no invisible negotiation outside model-call accounting",
    );
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).stream_options, undefined);
      return providerResponse(
        'data: {"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    };
    const explicit = new OpenAICompatibleProvider({
      ...config,
      streamUsage: false,
    });
    const events = [];
    for await (const event of explicit.stream({ model: "test", messages: [] }))
      events.push(event);
    assert.equal(calls, 2);
    assert.equal(events.at(-1).usage.totalTokens, null);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        { error: { message: "stream_options auth" } },
        { status: 401 },
      );
    };
    await assert.rejects(async () => {
      for await (const event of provider.stream({
        model: "test",
        messages: [],
      })) {
      }
    }, ProviderAuthenticationError);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible provider normalizes text, tool calls, usage and duration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools[0].function.name, "list_products");
    assert.deepEqual(body.tool_choice, {
      type: "function",
      function: { name: "list_products" },
    });
    assert.deepEqual(body.response_format, { type: "json_object" });
    return providerResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "我先查一下产品。",
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "list_products",
                    arguments: '{"search":"暖风机"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      }),
      { status: 200 },
    );
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
    });
    const result = await provider.chat({
      model: "test-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "question" },
      ],
      tools: [
        {
          name: "list_products",
          description: "list",
          parameters: { type: "object" },
        },
      ],
      toolChoice: { name: "list_products" },
      responseFormat: { type: "json_object" },
    });
    assert.equal(result.content, "我先查一下产品。");
    assert.deepEqual(result.toolCalls, [
      { id: "call-1", name: "list_products", arguments: { search: "暖风机" } },
    ]);
    assert.deepEqual(result.usage, {
      inputTokens: 10,
      outputTokens: 6,
      totalTokens: 16,
    });
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(typeof result.durationMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider normalizes content parts and object tool arguments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    providerResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: '{"type":"tool"}' },
                { type: "text", text: "\n" },
              ],
              tool_calls: [
                {
                  id: "call-2",
                  function: {
                    name: "list_products",
                    arguments: { search: "暖风机" },
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
    });
    const result = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "question" }],
      responseFormat: { type: "json_object" },
    });
    assert.equal(result.content, '{"type":"tool"}');
    assert.deepEqual(result.toolCalls[0].arguments, { search: "暖风机" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("structured output never downgrades even with a legacy auto setting", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1)
      return providerResponse(
        JSON.stringify({
          error: { message: "response_format is not supported" },
        }),
        { status: 400 },
      );
    return providerResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: '{"type":"final"}' },
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
      structuredOutput: "auto",
    });
    await assert.rejects(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "question" }],
        responseFormat: { type: "json_object" },
      }),
      ProviderUnsupportedResponseFormatError,
    );
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.equal(bodies.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicit request contract cannot be disabled by a legacy provider setting", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.response_format, { type: "json_object" });
    return providerResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "{}" },
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
      structuredOutput: "disabled",
    });
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "question" }],
      responseFormat: { type: "json_object" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("required structured output reports unsupported endpoints without dropping the contract", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(init.body).response_format, {
      type: "json_object",
    });
    return providerResponse(
      JSON.stringify({
        error: { message: "response_format is not supported" },
      }),
      { status: 400 },
    );
  };
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
      structuredOutput: "required",
    });
    await assert.rejects(
      () =>
        provider.chat({
          model: "test-model",
          messages: [],
          responseFormat: { type: "json_object" },
        }),
      ProviderUnsupportedResponseFormatError,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider maps authentication, rate limit and timeout failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const noKey = new OpenAICompatibleProvider({
      apiKey: "",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
    });
    await assert.rejects(
      () => noKey.chat({ model: "test-model", messages: [] }),
      ProviderAuthenticationError,
    );

    globalThis.fetch = async () => providerResponse("{}", { status: 429 });
    const rateLimited = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
    });
    await assert.rejects(
      () => rateLimited.chat({ model: "test-model", messages: [] }),
      ProviderRateLimitError,
    );

    globalThis.fetch = async () => {
      throw new DOMException("timeout", "TimeoutError");
    };
    const timedOut = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
      supportedModels: ["test-model"],
    });
    await assert.rejects(
      () => timedOut.chat({ model: "test-model", messages: [] }),
      ProviderTimeoutError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider distinguishes retryable 429 rate-limit with Retry-After from non-retryable 429 quota exhaustion and 4xx invalid requests", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://test.example.invalid/api/v3",
      model: "test-model",
      timeoutMs: 1000,
    });

    globalThis.fetch = async () =>
      providerResponse(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "You exceeded your current quota",
          },
        }),
        { status: 429 },
      );
    await assert.rejects(
      () => provider.chat({ model: "test-model", messages: [] }),
      (err) =>
        err instanceof ProviderQuotaExhaustedError &&
        err.retryable === false &&
        err.errorKind === "quota",
    );

    globalThis.fetch = async () =>
      providerResponse(
        JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
        { status: 429, headers: { "Retry-After": "3" } },
      );
    await assert.rejects(
      () => provider.chat({ model: "test-model", messages: [] }),
      (err) =>
        err instanceof ProviderRateLimitError &&
        err.retryable === true &&
        err.retryAfterMs === 3000,
    );

    globalThis.fetch = async () =>
      providerResponse(
        JSON.stringify({ error: { message: "bad parameter" } }),
        { status: 400 },
      );
    await assert.rejects(
      () => provider.chat({ model: "test-model", messages: [] }),
      (err) =>
        err instanceof ProviderInvalidRequestError && err.retryable === false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
