import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "MouseEvent",
])
  globalThis[key] = dom.window[key];
const require = createRequire(import.meta.url);
const { createApp, h, reactive, nextTick } = require("vue");
const source = await readFile(
  new URL("../../packages/chat-ui/src/ChatInteraction.vue", import.meta.url),
  "utf8",
);
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, {
  id: "interaction-test",
  inlineTemplate: true,
});
const js = ts.transpileModule(compiled.content, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
const controls = {
  ElButton: {
    props: ["disabled", "loading", "type"],
    setup:
      (props, { slots, attrs }) =>
      () =>
        h("button", { ...attrs, disabled: props.disabled }, slots.default?.()),
  },
  ElInput: {
    props: ["modelValue", "disabled"],
    emits: ["update:modelValue", "input"],
    setup:
      (props, { emit, attrs }) =>
      () =>
        h("textarea", {
          ...attrs,
          value: props.modelValue,
          disabled: props.disabled,
          onInput: (event) => {
            emit("update:modelValue", event.target.value);
            emit("input", event.target.value);
          },
        }),
  },
};
new Function("require", "exports", "module", js)(
  (name) => (name === "element-plus" ? controls : require(name)),
  module.exports,
  module,
);
const Component = module.exports.default;
function mount(interaction) {
  const node = document.createElement("div");
  document.body.append(node);
  const props = reactive({
    interaction,
    disabled: false,
    submitting: false,
    error: "",
  });
  const responses = [];
  let cancelled = false;
  const app = createApp({
    render: () =>
      h(Component, {
        ...props,
        onRespond: (value) => responses.push(value),
        onCancel: () => {
          cancelled = true;
        },
      }),
  });
  app.mount(node);
  return {
    node,
    props,
    responses,
    cancelled: () => cancelled,
    close: () => {
      app.unmount();
      node.remove();
    },
  };
}
const button = (node, text) =>
  [...node.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === text,
  );
const base = {
  id: "interaction-1",
  runId: "run-1",
  revision: 1,
  status: "pending",
  expiresAt: "2099-01-01T00:00:00Z",
};

test("question card supports a choice, free text and task cancellation while keeping labels inert", async () => {
  const view = mount({
    ...base,
    kind: "question",
    question: "<img src=x onerror=alert(1)>你的预算？",
    options: [
      { id: "low", label: "2000 元以内" },
      { id: "mid", label: "2000–3000 元" },
    ],
    allowCustom: true,
  });
  try {
    assert.equal(view.node.querySelector("img"), null);
    assert.equal(button(view.node, "提交回答").disabled, true);
    button(view.node, "2000–3000 元").click();
    await nextTick();
    button(view.node, "提交回答").click();
    assert.deepEqual(view.responses[0], {
      kind: "question",
      interactionId: base.id,
      revision: 1,
      optionId: "mid",
    });
    button(view.node, "自由填写").click();
    await nextTick();
    const input = view.node.querySelector("textarea");
    input.value = " 2800 元 ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    button(view.node, "提交回答").click();
    assert.deepEqual(view.responses[1], {
      kind: "question",
      interactionId: base.id,
      revision: 1,
      text: "2800 元",
    });
    view.props.submitting = true;
    await nextTick();
    assert.ok(
      [...view.node.querySelectorAll("button")].every((item) => item.disabled),
    );
    view.props.submitting = false;
    await nextTick();
    button(view.node, "取消任务").click();
    assert.equal(view.cancelled(), true);
    view.props.interaction = {
      ...view.props.interaction,
      status: "answered",
      answer: { optionId: "mid" },
    };
    await nextTick();
    assert.equal(view.node.querySelectorAll("button").length, 0);
    assert.match(view.node.textContent, /已回答.*2000–3000 元/s);
  } finally {
    view.close();
  }
});

test("approval shows safe parameters, emits only a decision and keeps a processed card read only", async () => {
  const view = mount({
    ...base,
    kind: "approval",
    toolName: "submit_request",
    description: "提交申请",
    arguments: { amount: 2499, note: "<script>alert(1)</script>" },
  });
  try {
    assert.equal(view.node.querySelector("script"), null);
    assert.match(view.node.querySelector("pre").textContent, /2499/);
    button(view.node, "批准本次调用").click();
    button(view.node, "拒绝").click();
    assert.deepEqual(view.responses, [
      {
        kind: "approval",
        interactionId: base.id,
        revision: 1,
        decision: "approve",
      },
      {
        kind: "approval",
        interactionId: base.id,
        revision: 1,
        decision: "reject",
      },
    ]);
    view.props.interaction = { ...view.props.interaction, status: "approved" };
    await nextTick();
    assert.equal(view.node.querySelectorAll("button").length, 0);
    assert.match(view.node.textContent, /已批准/);
    assert.match(view.node.querySelector("pre").textContent, /2499/);
  } finally {
    view.close();
  }
});
