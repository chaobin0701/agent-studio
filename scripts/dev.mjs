import { spawn, spawnSync } from "node:child_process";
import { root, environment } from "./environment.mjs";
const env = environment();
const build = spawnSync("npm", ["run", "build"], {
  cwd: root + "server",
  env,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
const children = [];
let stopping = false;
const grouped = process.platform !== "win32";
function signal(child, type) {
  if (!child.pid) return;
  try {
    process.kill(grouped ? -child.pid : child.pid, type);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(error.message);
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) signal(p, "SIGTERM");
  setTimeout(() => {
    for (const p of children) signal(p, "SIGKILL");
    process.exit(code);
  }, 4000).unref();
}
for (const [dir, args, extra] of [
  ["server", ["npm", "run", "dev:watch"], {}],
  ["server", ["npm", "run", "dev:api"], {}],
  ["server", ["npm", "run", "dev:worker"], {}],
  [
    "admin-vben",
    ["pnpm", "dev", "--port", env.ADMIN_PORT || "8085", "--host", "127.0.0.1"],
    { API_PROXY_TARGET: `http://127.0.0.1:${env.PORT || 3020}` },
  ],
]) {
  const [command, ...argv] = args;
  const child = spawn(command, argv, {
    cwd: root + dir,
    env: { ...env, ...extra },
    stdio: "inherit",
    detached: grouped,
  });
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
