const fs = require("node:fs");
const path = require("node:path");

// Compiler output only. Never accept a caller path, environment override or
// symlink to another checkout; this must run from the owning server package.
const root = path.resolve(__dirname, "..");
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(root)) {
  throw new Error("Build cleanup must run from the owning server package");
}
const output = path.join(root, "dist");
let existing;
try {
  existing = fs.lstatSync(output);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
  throw new Error("Compiler output must be a local directory, not a symlink");
}
if (existing) fs.rmSync(output, { recursive: true, force: true });
