import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../", import.meta.url));
export function environment() {
  const file = new URL("../.env", import.meta.url);
  if (!existsSync(file))
    throw Error(
      "Run npm run setup to generate independent local configuration first.",
    );
  process.loadEnvFile(file);
  return { ...process.env };
}
