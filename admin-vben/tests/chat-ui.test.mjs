import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const uiRequire = createRequire(require.resolve("@agent-studio/chat-ui"));
const { JSDOM } = require("jsdom");
const { computed } = require("vue"),
  ts = require("typescript"),
  { Marked } = uiRequire("marked");
const window = new JSDOM("").window;
const DOMPurify = uiRequire("dompurify")(window);
const source = readFileSync(
  new URL("../../packages/chat-ui/src/ChatMessage.vue", import.meta.url),
  "utf8",
);
const script = source
  .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?;\n/gm, "");
function render(content) {
  const context = {
    computed,
    Marked,
    DOMPurify,
    defineProps: () => ({ message: { role: "assistant", content } }),
    defineEmits: () => {},
    withDefaults: (props, defaults) => ({ ...defaults, ...props }),
  };
  runInNewContext(
    ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + "\nglobalThis.htmlResult=html.value;",
    context,
  );
  return context.htmlResult;
}
test("shared chat uses the installed Element Plus X message component and a single safe Markdown renderer", () => {
  assert.match(source, /from ['"]vue-element-plus-x['"]/);
  const html = render('**hello**\n\n```js\nconsole.log("ok")\n```');
  assert.match(html, /<strong>hello<\/strong>/);
  assert.match(html, /<pre><code/);
});
test("chat Markdown cannot run raw HTML, dangerous links or load remote tracking images", () => {
  const html = render(
    '<img src="https://tracking.invalid/pixel" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://tracking.invalid/pixel)',
  );
  assert(!/<(?:script|img|iframe|svg)\b/i.test(html));
  assert(!/href=["']javascript:/i.test(html));
});
