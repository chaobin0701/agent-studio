import { createTwoFilesPatch } from "diff";

/** Identical files need an explicit context hunk: ordinary patches omit it. */
export function createPromptPatch(
  left: string,
  right: string,
  expanded: boolean,
  fileName = "prompt.txt",
) {
  const patch = createTwoFilesPatch(fileName, fileName, left, right, "", "", {
    context: expanded ? Number.MAX_SAFE_INTEGER : 3,
    timeout: 800,
  });
  if (patch === undefined || left !== right || !left) return patch;
  const lines = left.split("\n");
  // A final newline terminates the last line; it is not an extra blank line.
  if (lines.at(-1) === "") lines.pop();
  return (
    patch +
    `@@ -1,${lines.length} +1,${lines.length} @@\n` +
    lines.map((line) => ` ${line}\n`).join("")
  );
}
