import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AdminUser, User } from '@onlinepay/db';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export type AuthedRequest = Request & { user?: User; admin?: AdminUser; sessionId?: string };

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 300) };
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new Error('CurrentUser used without SessionGuard');
  return req.user;
});

export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): AdminUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.admin) throw new Error('CurrentAdmin used without AdminGuard');
  return req.admin;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta =>
  requestMeta(ctx.switchToHttp().getRequest<Request>()),
);
