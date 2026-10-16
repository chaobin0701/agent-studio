import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { InMemoryRateLimitStore } from './in-memory-rate-limit-store';
import { RateLimitStore } from './rate-limit-store';

export type RateLimitScope = 'chat' | 'admin-login' | 'document-upload';

@Injectable()
export class SecurityRateLimitService {
  private readonly active = new Map<RateLimitScope, number>();

  constructor(
    @Optional() private readonly config?: AppConfigService,
  ) {}

  private readonly store: RateLimitStore = new InMemoryRateLimitStore();

  async run<T>(scope: RateLimitScope, identity: string, task: () => Promise<T>): Promise<T> {
    const store = this.store;
    const policy = this.policy(scope);
    const now = Date.now();
    const key = `${scope}:${identity || 'unknown'}`;
    let state = store.get(key);
    if (state && state.resetAt <= now) {
      store.delete(key);
      state = undefined;
    }
    if (!state && store.size() >= 10_000) {
      for (const [entryKey, entry] of store.entries()) if (entry.resetAt <= now) store.delete(entryKey);
      if (store.size() >= 10_000) throw this.exceeded();
    }
    const active = this.active.get(scope) ?? 0;
    if ((state?.count ?? 0) >= policy.limit || active >= policy.concurrency) throw this.exceeded();
    store.set(key, { count: (state?.count ?? 0) + 1, resetAt: state?.resetAt ?? now + policy.windowMs });
    return this.runConcurrent(scope, task);
  }

  /** Platform identities have durable app/key quotas; retain the process-wide expensive-work ceiling. */
  async runConcurrent<T>(scope: RateLimitScope, task: () => Promise<T>): Promise<T> {
    const active = this.active.get(scope) ?? 0;
    if (active >= this.policy(scope).concurrency) throw this.exceeded();
    this.active.set(scope, active + 1);
    try {
      return await task();
    } finally {
      this.active.set(scope, Math.max(0, (this.active.get(scope) ?? 1) - 1));
    }
  }

  private policy(scope: RateLimitScope): { windowMs: number; limit: number; concurrency: number } {
    if (scope === 'admin-login') return {
      windowMs: this.config?.security.adminLoginWindowMs ?? 60_000,
      limit: this.config?.security.adminLoginLimit ?? 5,
      concurrency: 20,
    };
    if (scope === 'document-upload') return {
      windowMs: this.config?.security.documentUploadWindowMs ?? 60_000,
      limit: this.config?.security.documentUploadLimit ?? 50,
      concurrency: this.config?.security.documentUploadConcurrency ?? 2,
    };
    return {
      windowMs: this.config?.security.chatWindowMs ?? 60_000,
      limit: this.config?.security.chatWindowLimit ?? 10,
      concurrency: this.config?.security.chatConcurrency ?? 5,
    };
  }

  private exceeded(): HttpException {
    return new HttpException({ code: 'rate_limit_exceeded', message: '请求过于频繁，请稍后重试。' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
