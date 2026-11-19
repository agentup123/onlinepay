import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { AdminUser, Prisma } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { AuthedRequest, CurrentAdmin, Meta, RequestMeta } from '../common/request';
import { env } from '../config/env';
import { CardsService } from '../cards/cards.service';
import { KycService } from '../kyc/kyc.service';
import { PaymentsService } from '../payments/payments.service';
import { STALE_WEBHOOK_MS, WebhooksService } from '../webhooks/webhooks.service';
import { Idempotent, IdempotencyInterceptor } from '../common/idempotency.interceptor';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  AdminAuthService,
  AdminGuard,
  Roles,
} from './admin-auth';

/** Validates an optional enum query parameter (unknown values are a 400, not a 500). */
function queryEnum<T extends string>(
  name: string,
  values: readonly [T, ...T[]],
  value: string | undefined,
): T | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = z.enum(values).safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_QUERY', param: name });
  return parsed.data;
}

const KYC_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO'] as const;
const CARD_STATUSES = ['ACTIVE', 'FROZEN', 'CANCELLED'] as const;
const PURCHASE_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
const FLAG_STATUSES = ['OPEN', 'REVIEWING', 'DISMISSED', 'ESCALATED'] as const;

/** Stored but never picked up by a worker, or failed at least once. */
const unprocessedWebhooks = (): Prisma.WebhookEventWhereInput => ({
  processedAt: null,
  OR: [{ attempts: { gte: 1 } }, { receivedAt: { lt: new Date(Date.now() - STALE_WEBHOOK_MS) } }],
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/),
});
const reasonSchema = z.object({ reason: z.string().trim().min(5).max(500) });
const kycDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'NEEDS_INFO']),
  note: z.string().max(1000).optional(),
});
const refundSchema = z.object({
  amountFils: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
});
const bundleUpdateSchema = z.object({
  priceFils: z.number().int().positive().optional(),
  cardQuota: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
});
const flagUpdateSchema = z.object({
  status: z.enum(['REVIEWING', 'DISMISSED', 'ESCALATED']),
  resolution: z.string().max(1000).optional(),
});
const disputeUpdateSchema = z.object({
  status: z.enum(['INVESTIGATING', 'RESOLVED_CUSTOMER', 'RESOLVED_MERCHANT', 'CLOSED']),
  notes: z.string().max(2000).optional(),
});

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, admin } = await this.auth.login(body.email, body.password, body.totp, meta);
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_MS,
    });
    return admin;
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[ADMIN_COOKIE];
    if (token) await this.auth.logout(token);
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@CurrentAdmin() admin: AdminUser) {
    return { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cards: CardsService,
    private readonly kyc: KycService,
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Get('stats')
  async stats() {
    const [users, pendingKyc, activeCards, openFlags, paid, failedWebhooks] = await Promise.all([
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.kycApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.card.count({ where: { status: 'ACTIVE' } }),
      this.prisma.suspiciousActivityFlag.count({ where: { status: 'OPEN' } }),
      this.prisma.purchase.aggregate({
        where: { status: 'PAID' },
        _sum: { totalFils: true },
        _count: true,
      }),
      this.prisma.webhookEvent.count({ where: unprocessedWebhooks() }),
    ]);
    return {
      users,
      pendingKyc,
      activeCards,
      openFlags,
      paidPurchases: paid._count,
      revenueFils: paid._sum.totalFils ?? 0,
      failedWebhooks,
    };
  }

  // ── Users ──
  @Get('users')
  users(@Query('q') q?: string) {
    const where: Prisma.UserWhereInput = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { fullName: { contains: q, mode: 'insensitive' } },
            { id: q },
          ],
        }
      : {};
    return this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, fullName: true, email: true, phone: true, status: true, createdAt: true },
    });
  }

  @Get('users/:id')
  async user(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        kyc: { orderBy: { createdAt: 'desc' } },
        cards: { orderBy: { createdAt: 'desc' } },
        purchases: { orderBy: { createdAt: 'desc' }, include: { refunds: true, invoice: true } },
        wallet: { include: { entries: { orderBy: { createdAt: 'desc' }, take: 50 } } },
        flags: { orderBy: { createdAt: 'desc' } },
        disputes: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException();
    // Viewing customer PII is itself audited.
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.user.view',
      targetType: 'User',
      targetId: id,
      meta,
    });
    return user;
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  @Roles('SUPPORT', 'COMPLIANCE')
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: 'SUSPENDED' } }),
      this.prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // A suspended user must not keep spending: freeze every live card at the issuer too.
    const cards = await this.cards.freezeAllForUser(
      { type: 'ADMIN', id: admin.id, reason: `user suspended: ${body.reason}` },
      id,
      meta,
    );
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.user.suspend',
      targetType: 'User',
      targetId: id,
      metadata: { ...body, cardsFrozen: cards.frozen, cardsFailed: cards.failed },
      meta,
    });
    return { ok: cards.failed.length === 0, cards };
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @Roles('COMPLIANCE')
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    await this.prisma.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.user.reactivate',
      targetType: 'User',
      targetId: id,
      metadata: body,
      meta,
    });
    return { ok: true };
  }

  // ── KYC ──
  @Get('kyc')
  kycQueue(@Query('status') status?: string) {
    return this.prisma.kycApplication.findMany({
      where: { status: queryEnum('status', KYC_STATUSES, status) ?? 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
  }

  @Post('kyc/:id/decision')
  @HttpCode(200)
  @Roles('COMPLIANCE')
  kycDecision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(kycDecisionSchema)) body: z.infer<typeof kycDecisionSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    return this.kyc.decide(id, body.decision, body.note, admin.id, meta);
  }

  // ── Bundles ──
  @Get('bundles')
  bundles() {
    return this.prisma.bundle.findMany({ orderBy: { createdAt: 'asc' } });
  }

  @Patch('bundles/:id')
  @Roles('SUPER_ADMIN')
  async updateBundle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(bundleUpdateSchema)) body: z.infer<typeof bundleUpdateSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const before = await this.prisma.bundle.findUniqueOrThrow({ where: { id } });
    const after = await this.prisma.bundle.update({ where: { id }, data: body });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.bundle.update',
      targetType: 'Bundle',
      targetId: id,
      before,
      after,
      meta,
    });
    return after;
  }

  // ── Cards ──
  @Get('cards')
  cardsList(@Query('status') status?: string) {
    const filter = queryEnum('status', CARD_STATUSES, status);
    return this.prisma.card.findMany({
      where: filter ? { status: filter } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
  }

  @Get('cards/:id/transactions')
  cardTransactions(@Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.cardTransaction.findMany({
      where: { cardId: id },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
  }

  @Post('cards/:id/freeze')
  @HttpCode(200)
  @Roles('SUPPORT', 'COMPLIANCE')
  async freezeCard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const card = await this.prisma.card.findUniqueOrThrow({ where: { id } });
    return this.cards.setFrozen(
      { type: 'ADMIN', id: admin.id, reason: body.reason },
      card.userId,
      id,
      true,
      meta,
    );
  }

  @Post('cards/:id/unfreeze')
  @HttpCode(200)
  @Roles('COMPLIANCE')
  async unfreezeCard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const card = await this.prisma.card.findUniqueOrThrow({ where: { id } });
    return this.cards.setFrozen(
      { type: 'ADMIN', id: admin.id, reason: body.reason },
      card.userId,
      id,
      false,
      meta,
    );
  }

  @Post('cards/:id/cancel')
  @HttpCode(200)
  @Roles('SUPPORT', 'COMPLIANCE')
  async cancelCard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const card = await this.prisma.card.findUniqueOrThrow({ where: { id } });
    return this.cards.cancel(
      { type: 'ADMIN', id: admin.id, reason: body.reason },
      card.userId,
      id,
      meta,
    );
  }

  // ── Purchases & refunds ──
  @Get('purchases')
  purchases(@Query('status') status?: string) {
    const filter = queryEnum('status', PURCHASE_STATUSES, status);
    return this.prisma.purchase.findMany({
      where: filter ? { status: filter } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, email: true } },
        refunds: true,
        invoice: { select: { number: true } },
      },
    });
  }

  @Post('purchases/:id/refund')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(refundSchema)) body: z.infer<typeof refundSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    return this.payments.refund(id, body.amountFils, body.reason, admin.id, meta);
  }

  // ── Monitoring ──
  @Get('flags')
  flags(@Query('status') status?: string) {
    return this.prisma.suspiciousActivityFlag.findMany({
      where: { status: queryEnum('status', FLAG_STATUSES, status) ?? 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
  }

  @Patch('flags/:id')
  @Roles('COMPLIANCE')
  async updateFlag(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(flagUpdateSchema)) body: z.infer<typeof flagUpdateSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const flag = await this.prisma.suspiciousActivityFlag.update({
      where: { id },
      data: { ...body, resolvedBy: admin.id },
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.flag.update',
      targetType: 'SuspiciousActivityFlag',
      targetId: id,
      after: body,
      meta,
    });
    return flag;
  }

  // ── Disputes ──
  @Get('disputes')
  disputes() {
    return this.prisma.dispute.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, email: true } } },
    });
  }

  @Patch('disputes/:id')
  @Roles('SUPPORT', 'COMPLIANCE')
  async updateDispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(disputeUpdateSchema)) body: z.infer<typeof disputeUpdateSchema>,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    const d = await this.prisma.dispute.update({ where: { id }, data: body });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.dispute.update',
      targetType: 'Dispute',
      targetId: id,
      after: body,
      meta,
    });
    return d;
  }

  // ── Audit & ops ──
  @Get('audit')
  auditLog(@Query('targetId') targetId?: string, @Query('actorId') actorId?: string) {
    return this.prisma.auditLog.findMany({
      where: { ...(targetId ? { targetId } : {}), ...(actorId ? { actorId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Get('webhooks/failed')
  failedWebhooks() {
    return this.prisma.webhookEvent.findMany({
      where: unprocessedWebhooks(),
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        provider: true,
        eventType: true,
        attempts: true,
        lastError: true,
        receivedAt: true,
      },
    });
  }

  @Post('webhooks/:id/retry')
  @HttpCode(200)
  @Roles('SUPER_ADMIN')
  async retryWebhook(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
    @Meta() meta: RequestMeta,
  ) {
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.webhook.retry',
      targetType: 'WebhookEvent',
      targetId: id,
      meta,
    });
    return this.webhooks.retry(id);
  }
}
