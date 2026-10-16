import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminRequest } from './admin.types';
import { AdminLoginDto } from './auth.dto';
import { SecurityRateLimitService } from '../security/security-rate-limit.service';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService, private readonly rateLimit: SecurityRateLimitService) {}

  @Post('login')
  login(@Body() body: AdminLoginDto, @Req() request: Request) {
    return this.rateLimit.run('admin-login', request.ip || request.socket.remoteAddress || 'unknown', () => this.auth.login(body));
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@Req() request: AdminRequest) {
    return this.auth.me(request.admin!);
  }
}
