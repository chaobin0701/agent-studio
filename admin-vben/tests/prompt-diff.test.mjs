import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript");
const { parse, html } = require("diff2html");
const source = readFileSync(
  new URL(
    "../apps/web-ele/src/views/prompts/components/prompt-diff.ts",
    import.meta.url,
  ),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const context = { exports: {}, require };
runInNewContext(compiled, context);
const { createPromptPatch } = context.exports;

test("identical text displays every line in both diff formats with zero changes", () => {
  const text = "第一行\n\n@@ -1,2 +1,2 @@\n+正文\n-正文\n末行";
  for (const expanded of [false, true]) {
    const files = parse(createPromptPatch(text, text, expanded));
    const lines = files[0].blocks.flatMap((block) => block.lines);
    assert.equal(lines.length, 6);
    assert.equal(files[0].addedLines, 0);
    assert.equal(files[0].deletedLines, 0);
    for (const [index, line] of lines.entries()) {
      assert.equal(line.type, "context");
      assert.equal(line.oldNumber, index + 1);
      assert.equal(line.newNumber, index + 1);
      assert.equal(line.content.slice(1), text.split("\n")[index]);
    }
    for (const outputFormat of ["side-by-side", "line-by-line"]) {
      const output = html(files, { outputFormat, drawFileList: false });
      assert.ok(output.includes("末行"));
      assert.ok(!output.includes("File without changes"));
    }
  }
});

test("identical text preserves blank lines and final newline semantics", () => {
  for (const [text, count] of [
    ["line\n", 1],
    ["line\n\n", 2],
    ["\n", 1],
    ["a\r\nb\r\n", 2],
  ]) {
    const files = parse(createPromptPatch(text, text, false));
    assert.equal(files[0].blocks[0].lines.length, count);
  }
  assert.equal(parse(createPromptPatch("", "", false))[0].blocks.length, 0);
});

test("changed content retains genuine addition and deletion markers", () => {
  const files = parse(createPromptPatch("old\nkept", "new\nkept", false));
  assert.equal(files[0].addedLines, 1);
  assert.equal(files[0].deletedLines, 1);
});

test("identical prompt HTML is escaped by the mature renderer", () => {
  const text = "<img src=x onerror=alert(1)>";
  const output = html(parse(createPromptPatch(text, text, false)), {
    outputFormat: "side-by-side",
  });
  assert.ok(!output.includes("<img src=x"));
  assert.ok(output.includes("&lt;img"));
});
