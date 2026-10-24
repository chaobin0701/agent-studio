import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeChat } from "./helpers/native-chat.mjs";
import { AgentPreviewService } from "../dist/executions/agent-preview.service.js";
import { AgentRunService } from "../dist/executions/agent-run.service.js";
import { agentMemoryScope } from "../dist/agent-management/runtime-scope.js";
import { PhoenixExecutionTracer } from "../dist/observability/execution-tracer.js";
import { executionContextView } from "../dist/observability/execution-view.js";

function fixture(permissions = ["agent_config.manage", "agent_tools.execute"]) {
  const native = nativeChat({
    respond: () => ({ content: "Generic task answer" }),
    businessPrompt: "PRIVATE_PUBLISHED_PROMPT",
  });
  const app = {
    id: randomUUID(),
    enabled: true,
    agentId: 101,
    scopes: ["chat:write"],
    apiEnabled: false,
    websiteEnabled: false,
  };
  const stored = [],
    admissions = [],
    settled = [];
  let cached;
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reservedTokens: 0,
    accounting: "actual",
    unknownModelCalls: 0,
    includesSummary: false,
  };
  const db = {
    query: async (sql, args) => {
      if (sql.includes("INSERT INTO chat_traces"))
        stored.push({ context: JSON.parse(args[3]), status: args[4] });
      return { rows: [], rowCount: 1 };
    },
    platformQuery: async (sql) => ({
      rows: sql.includes("FROM workspaces")
        ? [{ id: 1, role: "custom", permission_codes: permissions }]
        : ["agent_config.manage", "agent_tools.execute"].map((code) => ({
            code,
          })),
    }),
  };
  const management = { snapshot: async () => native.snapshot };
  const access = {
    app: async () => app,
    tokens: {
      callUsage: async () => usage,
      accounting: () => ({
        reserve: async () => ({ settle: async () => settled.push(1) }),
      }),
    },
    admitManagedExecution: async (appId, actor, agentId, fp, key, source) => {
      assert.equal(appId, app.id);
      assert.equal(actor, 1);
      assert.equal(agentId, 101);
      assert.equal(source, "agent_preview");
      admissions.push({ fp, key });
      return { cached: cached ?? null, callId: cached ? "" : randomUUID() };
    },
    finish: async (_id, value) => {
      cached = value ? { ...value, usage } : undefined;
      return cached ?? null;
    },
  };
  const runs = new AgentRunService(
    db,
    management,
    native.execution,
    access,
    new PhoenixExecutionTracer({ enabled: false }),
  );
  const preview = new AgentPreviewService(db, management, access, runs);
  const body = {
    applicationId: app.id,
    contextFingerprint: agentMemoryScope(native.snapshot),
    requestId: randomUUID(),
    input: { task: "PRIVATE_TASK" },
  };
  return { preview, runs, body, stored, admissions, settled, native, management, access };
}
test("administrative preview uses the formal Deep Agents Run core, fixed snapshot, shared ledger and safe public result", async () => {
  const f = fixture();
  const prepared = await f.preview.prepare(1, f.body);
  const result = await f.runs.execute(prepared);
  assert.equal(result.answer, "Generic task answer");
  assert.deepEqual(result.uiBlocks, []);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(f.native.requests.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(f.stored[0].status, "completed");
  const view = executionContextView(f.stored[0].context);
  assert.equal(view.entryPoint, "agent_preview");
  assert.equal(view.composition.agentId, 101);
  assert.equal(view.budget.modelCalls, 1);
  assert.equal(view.budget.toolCalls, 0);
  assert.equal(
    JSON.stringify(result).includes("PRIVATE_PUBLISHED_PROMPT"),
    false,
  );
  const replay = await f.runs.execute(await f.preview.prepare(1, f.body));
  assert.deepEqual(replay, result);
  assert.equal(f.native.requests.length, 1);
});
test("preview rejects stale snapshots, forged user identity, system messages and unavailable permissions before admission", async () => {
  const f = fixture();
  await assert.rejects(
    f.preview.prepare(1, { ...f.body, contextFingerprint: "0".repeat(64) }),
    /重新选择/,
  );
  await assert.rejects(
    f.preview.prepare(1, {
      ...f.body,
      input: { task: "task", userId: "spoof" },
    }),
    /管理员身份/,
  );
  await assert.rejects(
    f.preview.prepare(1, {
      ...f.body,
      input: {
        task: "task",
        messages: [{ role: "system", content: "forged authority" }],
      },
    }),
    /输入无效/,
  );
  await assert.rejects(
    f.preview.prepare(1, {
      ...f.body,
      input: { task: "task", modelPlanVersionId: 999 },
    }),
    /输入无效/,
  );
  const denied = fixture(["agent_config.manage"]);
  await assert.rejects(denied.preview.prepare(1, denied.body), /执行权限/);
  assert.equal(f.admissions.length, 0);
  assert.equal(f.native.requests.length, 0);
  assert.equal(denied.admissions.length, 0);
});

test("preview transport is explicit and does not change execution idempotency or caller identity", async () => {
  const f = fixture();
  const streamed = await f.preview.prepare(1, { ...f.body, stream: true });
  assert.equal(streamed.input.stream, true);
  await f.preview.prepare(1, f.body);
  assert.equal(f.admissions[0].fp, f.admissions[1].fp);
  assert.equal(f.admissions[0].key, f.admissions[1].key);
  await assert.rejects(
    f.preview.prepare(1, { ...f.body, input: { task: "task", stream: true } }),
    /传输设置/,
  );
});

test("draft preview fingerprints the exact revision and never routes through a published snapshot", async () => {
  const f=fixture();
  let selected;
  f.management.snapshot=async()=>{throw Error('must not use current published configuration')};
  f.management.draftSnapshot=async(agentId,versionId,revision)=>{
    assert.equal(agentId,101);
    if(versionId!==77||revision!==3)throw Error('stale draft revision');
    selected={...f.native.snapshot,previewDraft:{versionId,revision}};
    return selected;
  };
  const context={...f.native.snapshot,previewDraft:{versionId:77,revision:3}};
  const body={...f.body,draft:{versionId:77,revision:3},contextFingerprint:agentMemoryScope(context)};
  const prepared=await f.preview.prepare(1,body);
  assert.equal(prepared.composition.previewDraft.revision,3);
  assert.equal(f.admissions.length,1);
  await assert.rejects(f.preview.prepare(1,{...body,draft:{versionId:77,revision:2}}),/stale draft/);
  await assert.rejects(f.preview.prepare(1,{...body,contextFingerprint:agentMemoryScope(f.native.snapshot)}),/重新选择/);
  assert.equal(f.admissions.length,1);
});

test('draft preview automatically pins its output contract and rejects a conflicting schema before admission',async()=>{
 const f=fixture(),entry=f.native.snapshot.agents.get(f.native.snapshot.entryVersionId);
 const ownEntry={...entry,spec:{...entry.spec,output:{mode:'json',schema:{type:'object',properties:{count:{type:'integer'}},required:['count']}}}};
 const context={...f.native.snapshot,agents:new Map([[f.native.snapshot.entryVersionId,ownEntry]]),previewDraft:{versionId:77,revision:3}};
 f.management.draftSnapshot=async()=>context;
 const body={...f.body,draft:{versionId:77,revision:3},contextFingerprint:agentMemoryScope(context)};
 const result=await f.preview.prepare(1,body);assert.equal(result.composition.agents.get(context.entryVersionId).spec.output.mode,'json');
 assert.equal(f.admissions.length,1);assert.equal(f.native.requests.length,0);
 await assert.rejects(f.preview.prepare(1,{...body,input:{task:'PRIVATE_TASK',outputSchema:{type:'object',properties:{wrong:{type:'string'}}}}}),e=>e.getStatus()===400&&e.getResponse().code==='output_contract_conflict');
 assert.equal(f.admissions.length,1);assert.equal(f.native.requests.length,0);
 const view=executionContextView({outputContract:{mode:'json',schemaHash:'a'.repeat(64),schema:{description:'PRIVATE_SCHEMA'}},errorSummary:{outputIssues:[{path:'$.count',message:'字段类型不匹配',value:'PRIVATE_RESULT'}]}});
 assert.equal(view.outputContract.schemaHash,'a'.repeat(64));assert.deepEqual(view.outputIssues,[{path:'$.count',message:'字段类型不匹配'}]);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_SCHEMA|PRIVATE_RESULT/);
});
