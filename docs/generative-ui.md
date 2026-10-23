# Generative UI (showcase)

The `present` Tool is an optional, read-only Tool resource. It renders only in the React showcase. The Vue admin manages its version and Agent binding; it does not render generated UI. The first catalog contains Card, Row, Fact, Chart (bar/line), and Table. It has no actions or forms.

## Configure

1. In the showcase repository, register component props and descriptions in `lib/generative-ui/definitions.ts`, renderers in `components/generative-ui.tsx`, then run `npm run ui:catalog`. Commit and deploy the resulting `lib/generative-ui/catalog.json` with the showcase. `npm run ui:catalog:check` detects a stale export.
2. In admin, create a Tool of type **生成式 UI（assistant-ui）**, paste the entire catalog JSON, test it, and publish a Tool version. The server verifies the catalog hash and validates complete component trees; it never loads React code or remote schema references.
3. Explicitly select that published Tool version in the Agent's **生成式 UI（展示站）** control, then publish the Agent version. With no binding, the Agent cannot call `present`. Existing Tool resource permissions, versions, testing, and execution limits apply.

For a new component, update/deploy the showcase first, then import and publish the new catalog as a Tool version and update the Agent binding. The backend accepts the catalog as versioned data, so a backend deployment is normally unnecessary. Keep older showcase code available while older catalog versions can still appear in chat history; otherwise their blocks use fallback text.

## Wire contract

After a complete `present` call passes server validation, streaming endpoints emit:

```text
event: tool_ui
data: {"protocolVersion":1,"runId":"run-1","blockId":"run-1:call-1:0","toolCallId":"call-1","adapter":"assistant-ui","catalogVersion":"<sha256>","revision":1,"status":"completed","tree":{"_type":"Fact","label":"Count","value":3},"fallbackText":"Count · 3"}
```

The existing `answer_delta`/`answer_reset` events still carry text. `tool_ui` does not finish the run. `done.uiBlocks` is the complete snapshot, with the same `blockId` and `revision` as any live `tool_ui`; conversation history and replay expose the same snapshot. Consumers upsert live blocks by `blockId`, replace them from `done.uiBlocks`, and treat only `done` as completion. Unsupported protocol, adapter, catalog version, or component uses `fallbackText`. The server persists validated Tool artifacts in the existing run/message storage; there is no new database table.

The catalog has one `present` schema for all components. The server validates each node's component-specific props in addition to the assistant-ui-generated schema, limits the tree to 80 nodes, depth 8, and 6000 serialized characters, and rejects unknown components and reserved props. The frontend validates again before rendering.
