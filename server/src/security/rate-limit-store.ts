export interface RateLimitState {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  get(key: string): RateLimitState | undefined;
  set(key: string, state: RateLimitState): void;
  delete(key: string): void;
  size(): number;
  entries(): IterableIterator<[string, RateLimitState]>;
}
