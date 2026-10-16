import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nativeChat } from "../test/helpers/native-chat.mjs";
import { KnowledgeSearchTool } from "../dist/ai/tools/knowledge-search.tool.js";
import {
  DEFAULT_AGENT_CONFIGURATION,
  parseAgentConfiguration,
} from "../dist/config/agent-config.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const expectedPath = path.join(root, "samples/eval/expected.json");

export async function loadCases() {
  return JSON.parse(await fs.readFile(expectedPath, "utf8")).cases;
}

const hit = {
  chunkId: 12,
  documentId: 3,
  documentTitle: "退货政策",
  originalFilename: "returns.md",
  ordinal: 0,
  headingPath: "退货条件",
  content: "七天内可申请退货。",
  sourceStartLine: 2,
  sourceEndLine: 4,
  score: 0.86,
};
const h2 = {
  brand: "Brand",
  category: "Heating",
  description: "Verified heater detail",
  revision: "v1",
  specifications: { power: "1500 W" },
  id: "heater-h2",
  name: "暖巢 H2 陶瓷暖风机",
  categoryId: "heating",
  summary: "适合卧室的小型陶瓷暖风机。",
  keySpecifications: ["额定功率：1500 W", "档位：三档"],
};
const h2Detail = {
  ...h2,
  specifications: { 额定功率: "1500 W", 档位: "三档", 额定电压: "220 V" },
};

function fixtureTool(name, data, content = JSON.stringify(data)) {
  return {
    name,
    description: name,
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async () => ({ success: true, content, data, references:(Array.isArray(data.products)?data.products:data.id?[data]:[]).map(item=>({kind:"record",id:item.id,title:item.name})) }),
  };
}

function createCaseRuntime(testCase) {
  let nextCallId = 0;
  const native = (name, args) => ({
    content: "",
    toolCalls: [{ id: `eval-${nextCallId++}`, name, arguments: args }],
  });
  const responses = {
    "returns-basic": [
      native("search_knowledge", { query: "退货期限" }),
      {
        type: "final",
        status: "answered",
        answer: "七天内可申请退货。",
        citationIds: [12],
      },
    ],
    "returns-citation": [
      native("search_knowledge", { query: "退货政策" }),
      {
        type: "final",
        status: "answered",
        answer: "七天内可申请退货。",
        citationIds: [12],
      },
    ],
    "unsupported-refusal": [
      native("search_knowledge", { query: "海外配送" }),
      {
        type: "final",
        status: "refused",
        answer: "无法确定，建议联系人工。",
        citationIds: [],
      },
    ],
    "product-list": [
      native("mcp_record_service_list_records", {}),
      {
        type: "final",
        status: "answered",
        answer: "暖巢 H2 是产品之一。",
        citationIds: [],
        referenceIds: ["heater-h2"],
      },
    ],
    "product-detail": [
      native("mcp_record_service_list_records", {}),
      native("mcp_record_service_get_record_detail", {
        productId: "heater-h2",
      }),
      {
        type: "final",
        status: "answered",
        answer: "H2 额定功率为 1500 W，三档。",
        citationIds: [],
        referenceIds: ["heater-h2"],
      },
    ],
    "duplicate-call": [
      native("search_knowledge", { query: "退货政策" }),
      native("search_knowledge", { query: "退货政策" }),
    ],
    "tool-limit": [
      native("search_knowledge", { query: "退货政策 1" }),
      native("search_knowledge", { query: "退货政策 2" }),
      native("search_knowledge", { query: "退货政策 3" }),
      native("search_knowledge", { query: "退货政策 4" }),
    ],
    "session-isolation": [
      native("search_knowledge", { query: "退货政策" }),
      {
        type: "final",
        status: "answered",
        answer: "七天内可申请退货。",
        citationIds: [12],
      },
    ],
  }[testCase.id];
  const tools = [
    new KnowledgeSearchTool({
      searchForAgent: async () => ({
        hits: testCase.id === "unsupported-refusal" ? [] : [hit],
        retrievalMode: "lexical-only",
        vectorIndexedChunks: 0,
      }),
    }),
    fixtureTool("mcp_record_service_list_records", {
      total: 1,
      products: [h2],
    }),
    fixtureTool("mcp_record_service_get_record_detail", h2Detail),
  ];
  const agent = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  Object.assign(agent.runtime, testCase.runtime ?? {});
  const host = nativeChat({
    configuration: parseAgentConfiguration(agent),
    tools,
    knowledge: [{ id: 1, indexVersionId: 10 }],
    respond: () => {
      const next = responses.shift();
      return {
        ...(next?.toolCalls
          ? next
          : {
              content: JSON.stringify(
                next ?? {
                  status: "refused",
                  answer: "No further verified facts",
                  citationIds: [],
                          },
              ),
            }),
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    },
  });
  return { runner: host.runner };
}

export async function evaluateCase(testCase) {
  const started = Date.now();
  const { runner } = createCaseRuntime(testCase);
  const result = await runner.run({
    question: testCase.question,
    summary: "",
    recentHistory: [],
  });
  const expected = testCase.expected;
  const traces = result.toolCalls;
  const keys = traces.map((trace) =>
    JSON.stringify({ name: trace.name, arguments: trace.arguments }),
  );
  const duplicateCount = keys.length - new Set(keys).size;
  const checks = {
    refused: result.result.refused === expected.refused,
    citationRequired:
      expected.citationRequired === undefined ||
      (expected.citationRequired ? result.result.citations.length > 0 : true),
    evidenceDocument:
      !expected.evidenceDocument ||
      result.sources.some(
        (source) =>
          source.originalFilename === expected.evidenceDocument &&
          (expected.mustContain ?? []).every((text) =>
            source.content.includes(text),
          ),
      ),
    productId:
      !expected.productId ||
      (result.output.references ?? []).some(
        (product) => product.id === expected.productId,
      ),
    noDuplicateToolCalls:
      !expected.noDuplicateToolCalls || duplicateCount === 0,
    duplicateCount:
      expected.duplicateCount === undefined ||
      duplicateCount >= expected.duplicateCount,
    // Policy-rejected attempts are observable traces, but never execute a tool.
    maxToolCalls:
      expected.maxToolCalls === undefined ||
      traces.filter((trace) => trace.ok).length <= expected.maxToolCalls,
    toolCallCountAtMost:
      expected.toolCallCountAtMost === undefined ||
      traces.length <= expected.toolCallCountAtMost,
    toolError:
      !expected.toolError ||
      traces.some((trace) => trace.errorCode === expected.toolError),
    sessionEvidenceMustNotContain:
      !expected.sessionEvidenceMustNotContain ||
      !JSON.stringify(result.contextSnapshot).includes(
        expected.sessionEvidenceMustNotContain,
      ),
  };
  return {
    caseId: testCase.id,
    passed: Object.values(checks).every(Boolean),
    checks,
    refused: result.result.refused,
    toolCalls: {
      count: traces.length,
      succeeded: traces.filter((trace) => trace.ok).length,
      duplicates: duplicateCount,
      names: traces.map((trace) => trace.name),
    },
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
    },
    latencyMs: Date.now() - started,
    loadedSkills: result.loadedSkills,
  };
}

export async function evaluate(cases, onlyCase) {
  const selected = onlyCase
    ? cases.filter((item) => item.id === onlyCase)
    : cases;
  if (onlyCase && selected.length === 0)
    throw new Error(`Unknown evaluation case: ${onlyCase}`);
  const results = await Promise.all(selected.map(evaluateCase));
  return {
    version: 2,
    mode: "offline",
    executionEngine: "deepagents",
    passed: results.every((result) => result.passed),
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    cases: results,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const onlyCase = process.argv[process.argv.indexOf("--case") + 1];
  const report = await evaluate(
    await loadCases(),
    process.argv.includes("--case") ? onlyCase : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
