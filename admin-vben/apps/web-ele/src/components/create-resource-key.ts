/** Generate once when opening a creation form, not on every submit/retry. */
export function newResourceKey(
  kind: "agent" | "skill" | "tool" | "mcp" | "prompt",
) {
  return `${kind}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function validResourceKey(value: string) {
  return /^[a-z][a-z0-9_]{0,79}$/.test(value.trim());
}
