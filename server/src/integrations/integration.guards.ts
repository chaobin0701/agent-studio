import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { browserOrigin, IntegrationService } from './integration.service';
import { INTERNAL_APP_ID, type IntegrationRequest } from './integration.types';

@Injectable()
export class AgentAccessGuard implements CanActivate {
  constructor(private readonly access: IntegrationService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    request.integration = await this.access.authenticate(request);
    return true;
  }
}

@Injectable()
export class LegacyWebsiteGuard implements CanActivate {
  constructor(private readonly access: IntegrationService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    if (request.path === '/api/chat/presentation') return true;
    if (request.headers.authorization) {
      const identity = await this.access.authenticate(request);
      if (identity.kind !== 'website') throw new ForbiddenException('平台密钥请使用 /api/v1/agent 接口');
      request.integration = identity;
    } else {
      // Old same-origin browsers retain their HttpOnly visitor cookie. Headless callers cannot omit Origin.
      const origin = browserOrigin(request);
      const app = await this.access.websiteApp(INTERNAL_APP_ID, origin);
      request.integration = { app, kind: 'website', scopes: app.scopes };
    }
    this.access.assertScope(request.integration, request.method === 'DELETE' ? 'conversations:delete' : request.method === 'GET' ? 'conversations:read' : 'chat:write');
    return true;
  }
}
