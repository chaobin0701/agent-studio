import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type { SpecializedWorkflow } from "./specialized-workflow";

/** Optional reference flow: deterministic, resource-free, no paid model calls.
 * Registering it only makes a target available to published Tool management. */
export const textStatistics: SpecializedWorkflow = {
  key: "flow_text_statistics_v1",
  version: "1",
  description: "确定性文本统计：仅返回字符、非空字符和非空行数，不调用大模型。",
  inputSchema: z.object({ text: z.string().max(24000) }).strict(),
  outputSchema: z
    .object({
      characters: z.number().int().nonnegative(),
      nonWhitespace: z.number().int().nonnegative(),
      nonEmptyLines: z.number().int().nonnegative(),
    })
    .strict(),
  allowedTools: [],
  limits: {
    maxSteps: 2,
    maxModelCalls: 0,
    maxToolCalls: 0,
    maxDurationMs: 1000,
  },
  build(effects) {
    const State = Annotation.Root({
      text: Annotation<string>(),
      result: Annotation<{
        characters: number;
        nonWhitespace: number;
        nonEmptyLines: number;
      }>(),
    });
    const Output = Annotation.Root({
      characters: Annotation<number>(),
      nonWhitespace: Annotation<number>(),
      nonEmptyLines: Annotation<number>(),
    });
    return new StateGraph({
      stateSchema: Annotation.Root({ ...State.spec, ...Output.spec }),
      input: Annotation.Root({ text: Annotation<string>() }),
      output: Output,
    })
      .addNode("measure", (state) =>
        effects.node("measure", async () => ({
          result: {
            characters: [...state.text].length,
            nonWhitespace: [...state.text.replace(/\s/gu, "")].length,
            nonEmptyLines: state.text
              .split(/\r?\n/u)
              .filter((line) => line.trim()).length,
          },
        })),
      )
      .addNode("project", (state) =>
        effects.node("project", async () => state.result),
      )
      .addEdge(START, "measure")
      .addEdge("measure", "project")
      .addEdge("project", END)
      .compile();
  },
};
