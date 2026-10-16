import { Injectable } from '@nestjs/common';
import { RateLimitState, RateLimitStore } from './rate-limit-store';

@Injectable()
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly states = new Map<string, RateLimitState>();

  get(key: string): RateLimitState | undefined { return this.states.get(key); }
  set(key: string, state: RateLimitState): void { this.states.set(key, state); }
  delete(key: string): void { this.states.delete(key); }
  size(): number { return this.states.size; }
  entries(): IterableIterator<[string, RateLimitState]> { return this.states.entries(); }
}
