import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { HttpExceptionFilter } from './security/http-exception.filter';
import { RequestContextMiddleware } from './security/request-context.middleware';
import { RequestLoggerMiddleware } from './security/request-logger.middleware';
import { IntegrationService } from './integrations/integration.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // CSV imports are capped at 256 KB after decoding; allow JSON escaping overhead.
  app.useBodyParser('json', { limit: '512kb' });
  const config = app.get(AppConfigService);
  app.getHttpAdapter().getInstance().set('trust proxy', config.security.trustProxy);
  const access = app.get(IntegrationService);
  app.enableCors({ origin: (origin, callback) => {
    if (!origin) return callback(null, false);
    if (config.security.allowedOrigins.includes(origin)) return callback(null, true);
    void access.allowedOrigin(origin).then(allowed => callback(null, allowed)).catch(() => callback(null, false));
  }, credentials: true, exposedHeaders: ['Retry-After', 'X-Request-ID'] });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(app.get(RequestContextMiddleware).use.bind(app.get(RequestContextMiddleware)));
  app.use(app.get(RequestLoggerMiddleware).use.bind(app.get(RequestLoggerMiddleware)));
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
