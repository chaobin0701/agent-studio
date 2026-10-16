import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { normalizeError } from './error-response';
import { SecurityRequest } from './request-context.middleware';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<SecurityRequest & { admin?: { id: number } }>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? 'missing-request-id';
    const normalized = normalizeError(exception, requestId);
    if (normalized.body.error.retryAt) response.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(normalized.body.error.retryAt)-Date.now())/1000))));
    if (normalized.status >= 500) this.logger.error(JSON.stringify({ requestId, method: request.method, path: request.originalUrl, status: normalized.status }));
    response.status(normalized.status).json(normalized.body);
  }
}
