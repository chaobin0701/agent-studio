import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  lstat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("server builds remove stale compiler output, reject wrong-package and symlink cleanup, and publish no retired runtime modules", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "native-build-output-"));
  try {
    const root = path.join(temp, "server"),
      scripts = path.join(root, "scripts"),
      output = path.join(root, "dist");
    await mkdir(scripts, { recursive: true });
    await mkdir(output);
    const source = await readFile(
        new URL("../scripts/clean-build.cjs", import.meta.url),
        "utf8",
      ),
      script = path.join(scripts, "clean-build.cjs");
    await writeFile(script, source);
    await writeFile(path.join(output, "retired.js"), "old output");
    const wrong = spawnSync(process.execPath, [script], {
      cwd: temp,
      encoding: "utf8",
    });
    assert.notEqual(wrong.status, 0);
    assert.equal(
      await readFile(path.join(output, "retired.js"), "utf8"),
      "old output",
    );
    const clean = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stderr);
    await assert.rejects(lstat(output), { code: "ENOENT" });
    const elsewhere = path.join(temp, "another-checkout");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "keep.js"), "must remain");
    await symlink(elsewhere, output, "dir");
    const linked = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(linked.status, 0);
    assert.equal(
      await readFile(path.join(elsewhere, "keep.js"), "utf8"),
      "must remain",
    );
    for (const relative of [
      "ai/agent/agent-graph.js",
      "ai/agent/agent-loop.js",
      "ai/agent/agent-runner.js",
      "ai/runtime/platform-agent-adapter.js",
      "ai/runtime/platform-agent-nodes.js",
      "ai/runtime/platform-state.js",
      "ai/runtime/legacy-task-execution.js",
      "ai/tools/scoped-task.tool.js",
      "ai/extensions/runtime-extensions.js",
    ])
      await assert.rejects(
        lstat(new URL(`../dist/${relative}`, import.meta.url)),
        { code: "ENOENT" },
      );
    const contract = await readFile(
      new URL("../dist/ai/agent/execution-contract.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(contract, /AgentNodeAdapter|AGENT_GRAPH_VERSION/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
