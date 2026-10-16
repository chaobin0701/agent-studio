import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { html, parse } from "diff2html";
import { createPromptPatch } from "../src/views/prompts/components/prompt-diff.ts";

test("Skill comparison renders old and draft content in two columns with line numbers", () => {
  const patch = createPromptPatch(
    "---\nname: support\n---\n旧指导\n",
    "---\nname: support\n---\n新指导\n",
    false,
    "SKILL.md",
  );
  const files = parse(patch);
  assert.equal(files[0].oldName, "SKILL.md");
  assert.equal(files[0].newName, "SKILL.md");
  assert.equal(files[0].deletedLines, 1);
  assert.equal(files[0].addedLines, 1);
  const output = html(files, {
    drawFileList: false,
    outputFormat: "side-by-side",
  });
  assert.equal((output.match(/class="d2h-file-side-diff"/g) ?? []).length, 2);
  assert.match(output, /d2h-code-side-linenumber/);
  assert.match(output, /旧/);
  assert.match(output, /新/);
});

test("first publication has an empty old side and all draft lines are additions", () => {
  const files = parse(
    createPromptPatch("", "---\nname: support\n---\n指导\n", false, "SKILL.md"),
  );
  assert.equal(files[0].deletedLines, 0);
  assert.equal(files[0].addedLines, 4);
});

test("unchanged documents remain readable and existing Prompt filenames are preserved", () => {
  const files = parse(
    createPromptPatch("完整内容\n", "完整内容\n", false, "SKILL.md"),
  );
  assert.equal(files[0].blocks[0].lines[0].content, " 完整内容");
  assert.equal(files[0].addedLines, 0);
  assert.equal(files[0].deletedLines, 0);
  assert.equal(
    parse(createPromptPatch("old\n", "new\n", false))[0].newName,
    "prompt.txt",
  );
});

test("Skill review uses the shared side-by-side component rather than inline diff", () => {
  const detail = readFileSync(
    new URL("../src/views/resources/skill/detail.vue", import.meta.url),
    "utf8",
  );
  const component = readFileSync(
    new URL("../src/views/prompts/components/PromptDiff.vue", import.meta.url),
    "utf8",
  );
  assert.match(detail, /:left="comparable\(base\?\.config\)"/);
  assert.match(detail, /:right="comparable\(config\)"/);
  assert.match(detail, /file-name="SKILL\.md"/);
  assert.match(detail, /if \(!value\) return ""/);
  assert.doesNotMatch(detail, /diffLines|diff-added|diff-removed/);
  assert.match(
    component,
    /ref<"side-by-side" \| "line-by-line">\("side-by-side"\)/,
  );
});
