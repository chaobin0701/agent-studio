These fixtures are exported from the independent `agent-studio-showcase` repository:

- `catalog.json`: `npm run ui:catalog`, based on `@assistant-ui/generative-ui` 0.0.7 `buildPresentParameters` and Zod component schemas.
- `examples.json`: `lib/generative-ui/examples.ts` examples (21 components).

Keep these snapshots synchronized when updating that catalog. Tests intentionally use local fixtures rather than importing another application's runtime. They verify that new catalogs work with the generic Ajv validator without per-component backend code.
