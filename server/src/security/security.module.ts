import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/config.module';
import { InMemoryRateLimitStore } from './in-memory-rate-limit-store';
import { OriginCheckGuard } from './origin-check.guard';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestLoggerMiddleware } from './request-logger.middleware';
import { SecurityRateLimitService } from './security-rate-limit.service';
import { SecretBox } from './secret-box';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    InMemoryRateLimitStore,
    SecurityRateLimitService,
    SecretBox,
    RequestContextMiddleware,
    RequestLoggerMiddleware,
    { provide: APP_GUARD, useClass: OriginCheckGuard },
  ],
  exports: [InMemoryRateLimitStore, SecurityRateLimitService, RequestContextMiddleware, RequestLoggerMiddleware, SecretBox],
})
export class SecurityModule {}
