import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { safeIdentity, safePath } from './security-context';
import { SecurityRequest } from './request-context.middleware';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpRequest');

  use(request: SecurityRequest, response: Response, next: NextFunction): void {
    const started = Date.now();
    response.once('finish', () => {
      const adminId = (request as SecurityRequest & { admin?: { id: number } }).admin?.id;
      this.logger.log(JSON.stringify({
        requestId: request.requestId,
        method: request.method,
        path: safePath(request.originalUrl || request.url),
        status: response.statusCode,
        user: safeIdentity(adminId),
        durationMs: Date.now() - started,
      }));
    });
    next();
  }
}
