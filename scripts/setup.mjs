import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { root } from "./environment.mjs";
const file = new URL("../.env", import.meta.url);
if (!existsSync(file)) {
  const password = randomBytes(24).toString("hex");
  const template = readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8",
  )
    .replaceAll("replace-with-a-random-password", password)
    .replace(
      "replace-with-a-random-secret-of-at-least-32-characters",
      randomBytes(48).toString("hex"),
    )
    .replace(
      "replace-with-a-separate-random-encryption-key",
      randomBytes(48).toString("hex"),
    );
  writeFileSync(file, template, { mode: 0o600, flag: "wx" });
  console.log("Created private local .env; credentials are not printed.");
}
for (const [command, args] of [
  ["npm", ["ci", "--prefix", "server", "--install-links=true"]],
  ["pnpm", ["--dir", "admin-vben", "install", "--frozen-lockfile"]],
  ["npm", ["ci", "--prefix", "chat", "--install-links=true"]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  "Next: docker compose up -d postgres && npm run db:migrate && npm --prefix server run build && npm run admin:bootstrap && npm run dev",
);
