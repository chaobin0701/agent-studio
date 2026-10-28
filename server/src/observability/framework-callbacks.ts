import { dirname, join } from "node:path";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { GraphInterrupt } from "@langchain/langgraph";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { OITracer } from "@arizeai/openinference-core";
import {
  SemanticConventions,
  OpenInferenceSpanKind,
} from "@arizeai/openinference-semantic-conventions";
import {
  trace,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
  type SpanContext,
} from "@opentelemetry/api";

// 4.1.4 exports only the global patcher. Reuse its own callback tracer without
// constructing InstrumentationBase (which installs process-wide require hooks,
// even with enabled:false). This isolated version-pinned bridge is tested
// against the installed Core and actual Deep Agents/LangGraph callbacks.
type OfficialTracer = BaseCallbackHandler & {
  runMap: Map<string, unknown>;
  runTreeMap: Map<string, unknown>;
};
const { LangChainTracer } = require(
  join(
    dirname(
      require.resolve("@arizeai/openinference-instrumentation-langchain"),
    ),
    "tracer.js",
  ),
) as { LangChainTracer: new (tracer: OITracer) => OfficialTracer };
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const knownNodes = new Set([
  "platform-managed-agent",
  "__start__",
  "__end__",
  "model",
  "tools",
  "model_request",
  "FilesystemMiddleware.before_agent",
  "patchToolCallsMiddleware.before_agent",
  "SummarizationMiddleware.before_model",
  "PlatformExecutionGuard.before_model",
  "PlatformExecutionGuard.after_model",
  "PlatformHumanInteraction.after_model",
  "SkillsMiddleware.before_agent",
  "SubAgentMiddleware.before_agent",
]);
const serialized = {
  lc: 1,
  type: "not_implemented",
  id: ["framework", "operation"],
};
const safeId = (value: unknown) =>
  typeof value === "string" && idPattern.test(value) ? value : undefined;

export type FrameworkCapture = {
  callbacks: BaseCallbackHandler[];
  close(): void;
};

/** Request-local automatic SDK callbacks, not a global framework patch.
 * Bodies are discarded BEFORE the official tracer sees them; attributes,
 * status, exceptions and names are restricted AGAIN before the OTEL provider.
 * Framework spans are CHAINs without token counts: only model-attempt spans
 * represent paid LLM work, avoiding nested SDK/facade double counting. */
class MetadataFrameworkCallbacks extends BaseCallbackHandler {
  name = "platform_private_openinference";
  private readonly sdk: OfficialTracer;
  private readonly pending = new Set<string>();
  private readonly spans = new Map<string, Span>();
  private total = 0;
  private closed = false;
  copy(): this {
    return this;
  } // CallbackManager copies retain this request's tree.
  constructor(
    tracer: Tracer,
    private readonly root: Context,
    readonly ownerSpanId: string,
    private readonly metadata: Record<string, string | number | boolean | null>,
    allowedNames: readonly string[],
  ) {
    super({ _awaitHandler: true });
    const names = new Set([...knownNodes, ...allowedNames]);
    const safeName = (name: unknown) =>
      typeof name === "string" &&
      names.has(name) &&
      /^[a-z0-9_./-]{1,120}$/iu.test(name)
        ? name
        : "operation";
    this.nodeName = safeName;
    // Never expose the provider to the SDK. It receives an attribute-blind span
    // facade; even future SDK IO fields or exception formatting cannot leak.
    const bridge = {
      startSpan: (name: string, _options: unknown, parent?: Context): Span => {
        const base = trace.getSpanContext(root)!;
        const selected =
          parent && trace.getSpanContext(parent)?.traceId === base.traceId
            ? parent
            : root;
        const raw = tracer.startSpan(
          `framework/${safeName(name)}`,
          {},
          selected,
        );
        const attrs: Record<string, string | number | boolean> = {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]:
            OpenInferenceSpanKind.CHAIN,
          "app.layer": "framework",
          "langsmith.span.kind": "chain",
          metadata: JSON.stringify({
            ...metadata,
            ...(metadata.conversationId
              ? { thread_id: metadata.conversationId }
              : {}),
            framework: "openinference-langchain-4.1.4",
          }),
        };
        for (const [key, value] of Object.entries(metadata))
          if (value !== null) attrs[`app.${key}`] = value;
        raw.setAttributes(attrs);
        this.spans.set(raw.spanContext().spanId, raw);
        let ended = false;
        const facade: Span = {
          spanContext: () => raw.spanContext(),
          isRecording: () => raw.isRecording(),
          setAttribute: () => facade,
          setAttributes: () => facade,
          addEvent: () => facade,
          addLink: () => facade,
          addLinks: () => facade,
          updateName: () => facade,
          recordException: () => {},
          setStatus: (status) => {
            if (status.code === SpanStatusCode.ERROR)
              raw.addEvent("exception", {
                "exception.message": "framework_failed",
              });
            raw.setStatus({
              code: status.code,
              ...(status.code === SpanStatusCode.ERROR
                ? { message: "framework_failed" }
                : {}),
            });
            return facade;
          },
          end: () => {
            if (ended) return;
            ended = true;
            raw.end();
            this.spans.delete(raw.spanContext().spanId);
          },
        };
        return facade;
      },
    } as Tracer; // The official callback uses startSpan only, never startActiveSpan.
    this.sdk = new LangChainTracer(
      new OITracer({
        tracer: bridge,
        traceConfig: {
          hideInputs: true,
          hideOutputs: true,
          hideInputMessages: true,
          hideOutputMessages: true,
          hideInputText: true,
          hideOutputText: true,
          hideInputImages: true,
          hideEmbeddingVectors: true,
          hideLLMTools: true,
          hidePrompts: true,
        },
      }),
    );
  }
  private readonly nodeName: (name: unknown) => string;
  private async start(method: string, args: unknown[], runId: unknown) {
    const id = safeId(runId);
    if (this.closed || !id || this.pending.has(id) || this.total >= 512) return;
    this.pending.add(id);
    this.total++;
    await this.forward(method, args);
  }
  private async end(method: string, args: unknown[], runId: unknown) {
    const id = safeId(runId);
    if (this.closed || !id || !this.pending.delete(id)) return;
    await this.forward(method, args);
  }
  private async forward(method: string, args: unknown[]) {
    try {
      const fn = (
        this.sdk as unknown as Record<string, (...args: unknown[]) => unknown>
      )[method];
      if (typeof fn === "function") await fn.apply(this.sdk, args);
    } catch {
      /* Tracing incompatibility never fails business or logs data. */
    }
  }
  handleChainStart(...a: unknown[]) {
    return this.start(
      "handleChainStart",
      [
        serialized,
        {},
        safeId(a[2]),
        safeId(a[3]),
        [],
        {},
        "chain",
        this.nodeName(a[7]),
      ],
      a[2],
    );
  }
  handleChatModelStart(...a: unknown[]) {
    return this.start(
      "handleChatModelStart",
      [serialized, [], safeId(a[2]), safeId(a[3]), {}, [], {}, "model"],
      a[2],
    );
  }
  handleLLMStart(...a: unknown[]) {
    return this.start(
      "handleLLMStart",
      [serialized, [], safeId(a[2]), safeId(a[3]), {}, [], {}, "model"],
      a[2],
    );
  }
  handleToolStart(...a: unknown[]) {
    return this.start(
      "handleToolStart",
      [serialized, "", safeId(a[2]), safeId(a[3]), [], {}, this.nodeName(a[6])],
      a[2],
    );
  }
  handleRetrieverStart(...a: unknown[]) {
    return this.start(
      "handleRetrieverStart",
      [serialized, "", safeId(a[2]), safeId(a[3]), [], {}, "operation"],
      a[2],
    );
  }
  handleChainEnd(...a: unknown[]) {
    return this.end("handleChainEnd", [{}, safeId(a[1])], a[1]);
  }
  handleLLMEnd(...a: unknown[]) {
    return this.end("handleLLMEnd", [{ generations: [] }, safeId(a[1])], a[1]);
  }
  handleToolEnd(...a: unknown[]) {
    return this.end("handleToolEnd", ["", safeId(a[1])], a[1]);
  }
  handleRetrieverEnd(...a: unknown[]) {
    return this.end("handleRetrieverEnd", [[], safeId(a[1])], a[1]);
  }
  handleChainError(...a: unknown[]) {
    if (a[0] instanceof GraphInterrupt) {
      const id = safeId(a[1]);
      const context = id ? this.parent(id) : undefined;
      const span = context ? this.spans.get(context.spanId) : undefined;
      span?.setAttributes({
        "app.status": "waiting",
        metadata: JSON.stringify({
          ...this.metadata,
          ...(this.metadata.conversationId
            ? { thread_id: this.metadata.conversationId }
            : {}),
          framework: "openinference-langchain-4.1.4",
          status: "waiting",
        }),
      });
      // Native interrupt payloads never enter SDK error formatting or storage.
      return this.end("handleChainEnd", [{}, id], a[1]);
    }
    return this.end(
      "handleChainError",
      ["execution_failed", safeId(a[1])],
      a[1],
    );
  }
  handleLLMError(...a: unknown[]) {
    return this.end("handleLLMError", ["execution_failed", safeId(a[1])], a[1]);
  }
  handleToolError(...a: unknown[]) {
    return this.end(
      "handleToolError",
      ["execution_failed", safeId(a[1])],
      a[1],
    );
  }
  handleRetrieverError(...a: unknown[]) {
    return this.end(
      "handleRetrieverError",
      ["execution_failed", safeId(a[1])],
      a[1],
    );
  }
  parent(runId: string): SpanContext | undefined {
    // Only safe SDK run IDs and metadata-only span references exist in this map.
    const sdk = this.sdk as unknown as { runs: Record<string, { span: Span }> };
    return sdk.runs[runId]?.span.spanContext();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const span of this.spans.values()) {
      span.addEvent("exception", {
        "exception.message": "framework_incomplete",
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "framework_incomplete",
      });
      span.end();
    }
    this.spans.clear();
    this.pending.clear();
    this.sdk.runMap.clear();
    this.sdk.runTreeMap.clear();
    (this.sdk as unknown as { runs: Record<string, unknown> }).runs = {};
  }
}

export function createFrameworkCapture(
  tracer: Tracer,
  root: Context,
  ownerSpanId: string,
  metadata: Record<string, string | number | boolean | null>,
  allowedNames: readonly string[],
): FrameworkCapture {
  const handler = new MetadataFrameworkCallbacks(
    tracer,
    root,
    ownerSpanId,
    metadata,
    allowedNames,
  );
  return { callbacks: [handler], close: () => handler.close() };
}
function currentManager() {
  const callbacks =
    AsyncLocalStorageProviderSingleton.getRunnableConfig()?.callbacks;
  return callbacks instanceof CallbackManager ? callbacks : undefined;
}
export function frameworkParent(ownerSpanId: string): SpanContext | undefined {
  const manager = currentManager(),
    id = manager?.getParentRunId();
  if (!id) return;
  for (const handler of manager!.handlers)
    if (
      handler instanceof MetadataFrameworkCallbacks &&
      handler.ownerSpanId === ownerSpanId
    ) {
      const parent = handler.parent(id);
      if (parent) return parent;
    }
}
/** Preserve only our explicit metadata callback and privacy sentinels, never
 * ambient user/LangSmith handlers, tags or arbitrary configuration metadata. */
export function frameworkModelCallbacks(privacy: BaseCallbackHandler[]) {
  const manager = currentManager();
  const safe =
    manager?.handlers.filter((h) => h instanceof MetadataFrameworkCallbacks) ??
    [];
  if (!safe.length) return privacy;
  const handlers = [...privacy, ...new Set(safe)];
  return new CallbackManager(manager?.getParentRunId(), {
    handlers,
    inheritableHandlers: handlers,
  });
}
