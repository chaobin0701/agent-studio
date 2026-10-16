import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const { parse } = require("vue/compiler-sfc");
const root = new URL("../apps/web-ele/src/", import.meta.url);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : entry.name.endsWith(".vue")
        ? [join(dir, entry.name)]
        : [],
  );
}

test("all management dialogs retain native ElDialog and its public bounded-layout/teleport hooks", () => {
  let count = 0;
  for (const file of files(fileURLToPath(root))) {
    const { descriptor, errors } = parse(readFileSync(file, "utf8"));
    assert.deepEqual(errors, [], file);
    function walk(node, inDialog = false) {
      inDialog ||= node.type === 1 && node.tag === "ElDialog";
      if (node.type === 1 && node.tag === "ElDialog") {
        count++;
        const attr = (name) =>
          node.props.find((p) => p.type === 6 && p.name === name);
        for (const [name, value] of [
          ["class", "management-dialog"],
          ["body-class", "management-dialog-body"],
          ["header-class", "management-dialog-header"],
          ["footer-class", "management-dialog-footer"],
        ])
          assert(
            attr(name)?.value?.content.split(/\s+/).includes(value),
            file + ": " + name,
          );
        assert(
          attr("append-to-body"),
          file + ": dialogs must escape nested route/panel stacking contexts",
        );
        assert(
          !node.props.some((p) => p.name === "top" || p.arg?.content === "top"),
          file +
            ": per-page top offsets must not compete with shared centering",
        );
      }
      if (inDialog && node.type === 1 && node.tag === "ElScrollbar")
        assert(
          !node.props.some(
            (p) => p.name === "max-height" && /vh/.test(p.value?.content ?? ""),
          ),
          file + ": do not reintroduce a second viewport-height body scroller",
        );
      for (const child of node.children ?? []) walk(child, inDialog);
    }
    if (descriptor.template?.ast) walk(descriptor.template.ast);
  }
  assert(count >= 36, "the check must cover every current business dialog");
});

test("the app configures native dialog centering and imports the shared viewport/body/footer styles", () => {
  assert.match(
    readFileSync(new URL("app.vue", root), "utf8"),
    /:dialog="\{ alignCenter: true \}"/,
  );
  assert.match(
    readFileSync(new URL("bootstrap.ts", root), "utf8"),
    /import ['"]\.\/styles\/management-dialog\.css['"]/,
  );
  const css = readFileSync(
    new URL("styles/management-dialog.css", root),
    "utf8",
  );
  assert.match(css, /max-height:\s*calc\(100dvh - 2rem\)/);
  assert.match(css, /max-width:\s*calc\(100vw - 2rem\)/);
  assert.match(
    css,
    /\.management-dialog-body\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s,
  );
  assert.match(css, /\.management-dialog-footer\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert(
    !css.includes("!important"),
    "native props and app-owned classes should suffice",
  );
});
