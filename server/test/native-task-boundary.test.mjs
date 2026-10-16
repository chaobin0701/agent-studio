import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import {
  knowledgeResources,
} from "../dist/ai/context/context-contribution.js";
const task = {
  messages: [],
  task: "Complete generic task",
  versions: {},
  limits: { maxDecisions: 3, maxToolCalls: 2 },
};
const context = { runId: "native-boundary", traceId: "native-boundary-trace" };
const product = {
  id: "internal-source-23",
  name: "Verified source",
  brand: "",
  categoryId: "test",
  category: "test",
  summary: "confirmed",
  description: "private-data",
  specifications: {},
  revision: "v1",
};

test("native task has one canonical output, no Chat envelope/transcript or implicit business renderer", async () => {
  const tool = {
    name: "read_record",
    description: "Read authorized record",
    inputSchema: z.object({}).strict(),
    execute: async () => ({
      success: true,
      content: "confirmed",
      data: product,
      references:[{kind:"record",id:product.id,title:product.name}],
    }),
  };
  const f = nativeChat({
    tools: [tool],
    respond: (_request, round) =>
      round === 1
        ? {
            content: "",
            toolCalls: [{ id: "read-1", name: tool.name, arguments: {} }],
          }
        : {
            content: JSON.stringify({
              answer: `Keep ${product.id} as requested`,
              referenceIds: [product.id],
            }),
          },
  });
  const result = await f.execution.runTask(f.snapshot, task, context);
  assert.equal(result.output.answer, `Keep ${product.id} as requested`);
  assert.deepEqual(
    result.output.references.map((r) => r.id),
    [product.id],
  );
  for (const key of ["result", "products", "answerSegments", "loadedSkills"])
    assert.equal(Object.hasOwn(result, key), false);
  assert.equal(result.contextSnapshot.agentTranscript, undefined);
  assert.equal(result.contextSnapshot.transcriptVersion, undefined);
  assert.equal(result.contextSnapshot.products, undefined);
  assert.equal(f.requests.length, 2);
  const plain = nativeChat({ respond: () => ({ content: "Direct answer" }) });
  const single = await plain.execution.runTask(
    plain.snapshot,
    { ...task, limits: { maxDecisions: 1, maxToolCalls: 0 } },
    context,
  );
  assert.equal(single.output.answer, "Direct answer");
  assert.equal(plain.requests.length, 1);
});

test("Chat citation edge consumes validated capability contributions without concrete KnowledgeSearchTool inheritance", async () => {
  const hit = {
    chunkId: 11,
    documentId: 4,
    documentTitle: "Verified document",
    originalFilename: "source.md",
    headingPath: "Heading",
    content: "Validated evidence",
    sourceStartLine: 1,
    sourceEndLine: 2,
    score: 1,
    knowledgeBaseId: 7,
    indexVersionId: 3,
    indexKind: "published",
  };
  let projections = 0;
  const tool = {
    name: "read_authorized_evidence",
    description: "Read evidence",
    inputSchema: z.object({}).strict(),
    contributeContext: (r) => {
      projections++;
      return knowledgeResources(r);
    },
    execute: async () => ({
      success: true,
      content: "Validated evidence",
      data: { hits: [hit] },
    }),
  };
  const f = nativeChat({
    tools: [tool],
    respond: (_request, round) =>
      round === 1
        ? {
            content: "",
            toolCalls: [
              { id: "evidence-call", name: tool.name, arguments: {} },
            ],
          }
        : {
            content: JSON.stringify({
              answer: "Supported answer",
              citationIds: [hit.chunkId],
            }),
          },
  });
  const chat = await f.execution.run(f.snapshot, {
    question: "Question",
    summary: "",
    recentHistory: [],
    conversationId: "conversation-boundary",
  });
  assert.equal(chat.result.answer, "Supported answer");
  assert.equal(chat.result.citations[0].documentId, hit.documentId);
  assert.equal(chat.sources[0].indexVersionId, hit.indexVersionId);
  assert.equal(projections, 1, "only the gateway owns context projection");
  assert.deepEqual(
    chat.contextSnapshot.agentTranscript.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(f.requests.length, 2);
});
