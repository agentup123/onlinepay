import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sha256 } from '../common/crypto';
import type { AuthedRequest } from '../common/request';

export const SESSION_COOKIE = 'op_session';

/** Authenticates consumers via the opaque, httpOnly session cookie. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: string | undefined = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED' });
    }
    if (session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException({ code: 'ACCOUNT_NOT_ACTIVE' });
    }
    req.user = session.user;
    req.sessionId = session.id;
    return true;
  }
}
