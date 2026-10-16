import { spawnSync } from "node:child_process";
import { root } from "./environment.mjs";
const commands = {
  build: [
    ["npm", ["--prefix", "server", "run", "build"]],
    ["pnpm", ["--dir", "admin-vben", "build"]],
    ["npm", ["--prefix", "chat", "run", "build"]],
  ],
  typecheck: [
    ["npm", ["--prefix", "server", "run", "build"]],
    ["pnpm", ["--dir", "admin-vben", "typecheck"]],
    ["npm", ["--prefix", "chat", "run", "typecheck"]],
  ],
  test: [
    ["npm", ["--prefix", "server", "test"]],
    ["pnpm", ["--dir", "admin-vben", "test"]],
    ["npm", ["--prefix", "chat", "test"]],
  ],
};
const tasks = commands[process.argv[2]];
if (!tasks) throw Error("Expected build, typecheck or test");
for (const [cmd, args] of tasks) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
