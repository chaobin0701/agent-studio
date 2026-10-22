import { Allow, parse } from "partial-json";

/** Read only the fixed answer field from an incomplete structured envelope. */
export function partialJsonAnswer(value: string): string | undefined {
  try {
    const parsed: unknown = parse(value, Allow.OBJ | Allow.STR);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).answer === "string"
    )
      return (parsed as Record<string, string>).answer;
  } catch {
    // Incomplete or malformed fragments are ignored; final validation remains authoritative.
  }
  return undefined;
}
