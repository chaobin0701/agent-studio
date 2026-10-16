import { spawnSync } from "node:child_process";
import { root, environment } from "./environment.mjs";
const task = process.argv[2];
if (!["db:migrate", "admin:bootstrap"].includes(task))
  throw Error("Unsupported task");
const result = spawnSync("npm", ["run", task], {
  cwd: root + "server",
  env: environment(),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
