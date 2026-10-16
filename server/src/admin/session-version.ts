/** Existing tokens without a version remain valid only until the first reset. */
export function sessionVersionMatches(claim: unknown, current: number): boolean {
  const version = claim === undefined ? 0 : claim;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 && version === current;
}
