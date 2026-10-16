import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { ConsoleCallbackHandler } from "@langchain/core/tracers/console";

/** Suppress ambient LangSmith tracing without mutating process-wide settings.
 * The metadata-only platform Phoenix provider is the only authorized exporter. */
class PrivateFrameworkCallbacks extends BaseCallbackHandler {
  name = "langchain_tracer";
  updateFromRunTree(): void {}
  getRunTreeWithTracingConfig(): { extra: Record<PropertyKey, unknown> } {
    // Core stores its symbol-keyed RunnableConfig here for async propagation.
    // Returning undefined suppresses export but also drops task/stream context.
    // A fresh opaque carrier is NOT a LangSmith RunTree and has no exporter,
    // input/output fields, parent history or retained cross-request map.
    return { extra: {} };
  }
  copyWithTracingConfig(): this {
    return this;
  }
}

export const privateFrameworkCallbacks = new PrivateFrameworkCallbacks();

/** Prevent LANGCHAIN_VERBOSE from installing a body-logging console handler.
 * Local callbacks only: no global environment changes and no retained payloads. */
class SilentFrameworkConsole extends BaseCallbackHandler {
  // Match the same identity Core's CallbackManager actually checks. In the
  // pinned SDK `name` is an instance field, so prototype.name is undefined.
  // A hard-coded instance name does NOT suppress its verbose auto-handler.
  // Read the SDK identity without constructing a payload-retaining tracer.
  name = ConsoleCallbackHandler.prototype.name;
}
export const privateFrameworkCallbackHandlers = [
  privateFrameworkCallbacks,
  new SilentFrameworkConsole(),
];
