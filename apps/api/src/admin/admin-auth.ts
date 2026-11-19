import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import type { AdminRole } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { randomToken, sha256 } from '../common/crypto';
import type { AuthedRequest, RequestMeta } from '../common/request';

export const ADMIN_COOKIE = 'op_admin';
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day
const ROLES_KEY = 'admin_roles';

/** Restrict an admin route to roles. SUPER_ADMIN always passes. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, totp: string, meta: RequestMeta) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    // Always run bcrypt to keep timing uniform for unknown emails.
    const hash =
      admin?.passwordHash ?? '$2a$12$C6UzMDM.H6dfI/f/IKcEeO2ZTYV5RbyGQpWuQKu1jGa0lcj3cT2B6';
    const passwordOk = await bcrypt.compare(password, hash);
    const totpOk =
      !!admin?.totpSecret && authenticator.verify({ token: totp, secret: admin.totpSecret });

    if (!admin || !admin.active || !passwordOk || !totpOk) {
      await this.audit.log({
        actorType: 'ADMIN',
        actorId: admin?.id,
        action: 'admin.login_failed',
        metadata: { email },
        meta,
      });
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    }

    const token = randomToken();
    await this.prisma.adminSession.create({
      data: {
        adminId: admin.id,
        tokenHash: sha256(token),
        ip: meta.ip,
        expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS),
      },
    });
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.log({ actorType: 'ADMIN', actorId: admin.id, action: 'admin.login', meta });
    return {
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    };
  }

  async logout(token: string) {
    await this.prisma.adminSession.updateMany({
      where: { tokenHash: sha256(token) },
      data: { revokedAt: new Date() },
    });
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: string | undefined = req.cookies?.[ADMIN_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { admin: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.admin.active) {
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
    }
    const roles =
      this.reflector.get<AdminRole[] | undefined>(ROLES_KEY, ctx.getHandler()) ??
      this.reflector.get<AdminRole[] | undefined>(ROLES_KEY, ctx.getClass());
    if (roles && session.admin.role !== 'SUPER_ADMIN' && !roles.includes(session.admin.role)) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_ROLE' });
    }
    req.admin = session.admin;
    return true;
  }
}
