# Generative UI (showcase)

The `present` Tool is an optional, read-only Tool resource. It renders only in the React showcase. The Vue admin manages its version and Agent binding; it does not render generated UI. The catalog contains 21 components. The `present` call only emits a UI artifact; user interactions produce a separate, ordinary next-turn chat request.

| Purpose | Components |
| --- | --- |
| Layout and summaries | Card, Row, Fact, KeyValue, Badge, Tag |
| Content and references | Markdown, Alert, Image, Gallery, List |
| Data and process | Chart (bar/line), Table, Steps, Timeline |
| Content navigation | Accordion, Tabs |
| User input | Choice (single/multiple), ActionButton, Form, Confirmation |

The showcase `/ui-preview` page demonstrates every component without an Agent call. Examples are in `lib/generative-ui/examples.ts`. Tabs and Accordion use Radix; Markdown uses react-markdown/remark-gfm with raw HTML disabled. Images load in the browser, use known HTTPS or site-relative URLs, and have an unavailable-image fallback; the server does not proxy remote images.

## Configure

1. In the showcase repository, register component props and descriptions in `lib/generative-ui/definitions.ts`, renderers in `components/generative-ui.tsx`, then run `npm run ui:catalog`. Commit and deploy the resulting `lib/generative-ui/catalog.json` with the showcase. `npm run ui:catalog:check` detects a stale export.
2. In admin, create a Tool of type **生成式UI**, paste the entire catalog JSON, test it, and publish a Tool version. The server verifies the catalog hash and validates complete component trees; it never loads React code or remote schema references.
3. Select that published Tool version in the Agent's **能力 → Tools/工具** selector, then publish the Agent version. Generative UI and ordinary Tools have distinct icons in both options and selected tags. There is no separate UI switch; with no binding, the Agent cannot call `present`. Existing Tool resource permissions, versions, testing, and execution limits apply. The Agent only uses the Tool contract and component descriptions; the renderer's framework is an implementation detail.

For a new component, update/deploy the showcase first, then import and publish the new catalog as a Tool version and update the Agent binding. The backend accepts the catalog as versioned data, so a backend deployment is normally unnecessary. The showcase retains the initial five-component catalog in `lib/generative-ui/catalogs/initial.json` and selects supported catalogs by hash so old conversations still render. Preserve each deployed catalog before replacing it; unknown catalogs use fallback text.

## Wire contract

After a complete `present` call passes server validation, streaming endpoints emit:

```text
event: tool_ui
data: {"protocolVersion":1,"runId":"run-1","blockId":"run-1:call-1:0","toolCallId":"call-1","adapter":"assistant-ui","catalogVersion":"<sha256>","revision":1,"status":"completed","tree":{"_type":"Fact","label":"Count","value":3},"fallbackText":"Count · 3"}
```

The existing `answer_delta`/`answer_reset` events still carry text. `tool_ui` does not finish the run. `done.uiBlocks` is the complete snapshot, with the same `blockId` and `revision` as any live `tool_ui`; conversation history and replay expose the same snapshot. Consumers upsert live blocks by `blockId`, replace them from `done.uiBlocks`, and treat only `done` as completion. Unsupported protocol, adapter, catalog version, or component uses `fallbackText`. The platform persists validated Tool artifacts in the existing run/message storage. The independent showcase keeps submission receipts in its own SQLite request store; this does not add a platform execution engine.

The catalog has one `present` schema for all components. The server validates each node's component-specific props in addition to the assistant-ui-generated schema, limits the tree to 80 nodes, depth 8, and 6000 serialized characters, and rejects unknown components and reserved props. The frontend validates again before rendering.

## Validation and diagnostics

The showcase uses assistant-ui's `buildPresentParameters` for the model schema and `renderGenerativeUI` for rendering; Zod component definitions remain the source for exported property schemas. The official model schema merges component properties and does not enforce each component's required fields. The Tool description therefore includes a concise required/optional field summary derived from the same catalog. It does not rewrite the published parameter schema or its hash.

Ajv validates the exported JSON Schemas on the server. The existing bounded tree walk only selects the component validator and enforces platform limits. On invalid input, the ordinary Tool failure returns bounded, value-free Ajv diagnostics (`component`, JSON Pointer `path`, `field` when known, and `keyword`) to the existing model/tool loop. An empty pointer is the root. This adds no repair model call, automatic JSON correction, or hidden retry.

`tool_input_validation_failed` warnings include Tool version, trace/session identifiers when available, catalog version and at most 12 issues. Unknown model property names are omitted and unknown path segments become `*`; argument values, Ajv messages and raw errors are not logged. Ordinary execution views retain only this diagnostic projection.

`model_stream_failed` warnings distinguish malformed tool JSON (`argumentKind: invalid_json`) from non-object JSON (`non_object`), with tool-call index, argument character count, finish reason, attempt/deployment/version, duration and usage counters. A provider `length` finish reason is classified as `output_truncated` before parsing incomplete arguments. Model JSON and parser exception messages are not logged. Existing `tool_ui`, `answer_delta` and `done.uiBlocks` behavior is unchanged.


## Interaction contract

All components share the same `present` Tool and existing SSE events. Agent binding remains opt-in. The published component catalog is the authority for available props/actions; the backend contains no component-name-specific execution logic. Component descriptions and required/optional props are included in the model hint.

- `Choice`: unique `id`, title, options with unique `value` and label; optional `multiple`. Submit sends the selected labels in the next user message.
- `ActionButton`: unique `id`, label, and `action: {type: "send_message", message}` or `{type: "open_url", url}`. Links open in another tab; message actions do not directly execute any Tool or arbitrary HTTP request.
- `Form`: unique `id`, title, and fields with unique `name`. Supported types: text, textarea, number, select, date, checkbox. Select fields require options; the other fields have none. Required fields and typed values are validated on submission. Use only non-sensitive input. Composed chat messages remain limited to 1600 characters.
- `Confirmation`: unique `id`, title, description, and visible `message`; confirm/cancel sends that intent as a user message. It is not an approval grant. Platform `ask_user` and Tool approval cards continue to use their existing permission and resume flow.

The showcase POST `/api/chat/:demo` accepts either `{threadId, requestId, message}` or `{threadId, requestId, uiSubmission: {blockId, revision, componentId, values?, decision?}}`. These shapes are mutually exclusive. The server checks Origin and signed visitor ownership, loads the original completed assistant message from that owned conversation, validates the catalog/tree and exact revision, then derives the message from those persisted props. It rejects browser-supplied actions/text, invalid options/types, stale or foreign blocks, open-url submissions, and incomplete/refused producers. `values.selection` is an array of option values for Choice; Form values are keyed by field name; Confirmation uses `decision: "confirm" | "cancel"`.

A receipt is inserted atomically with the existing idempotent request and keyed by `(threadId, blockId, revision, componentId)`. Duplicate submissions with a fresh request ID are rejected; replay/recovery retains the original request ID and body. An uncertain network result disables new requests until explicit status refresh/recovery; there is no automatic resend with a new key. A failed continuation still retains its receipt: follow up with a normal message rather than resubmitting the card. Thread history includes `uiReceipts` with submitted values/decision and the linked request state. Refresh restores the submitted selection and disables that card. No changes to platform SSE are required. Unsubmitted form drafts are transient; unrelated chat drafts are preserved when submitting a UI card.

Update the showcase and deploy it before importing/publishing a new catalog and binding the new Tool version to an Agent. Development does not automatically publish either resource. The new backend description includes component behavior; subsequent component additions ordinarily only need a showcase release and catalog/Agent version updates.
