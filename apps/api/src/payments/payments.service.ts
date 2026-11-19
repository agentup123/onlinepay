import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { addVat } from '@onlinepay/shared';
import type { Prisma, User } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KycService } from '../kyc/kyc.service';
import { WalletService } from '../wallet/wallet.service';
import type { RequestMeta } from '../common/request';
import { env } from '../config/env';
import {
  GatewayEvent,
  GatewayRejectedError,
  PAYMENT_GATEWAY,
  PaymentGateway,
} from './gateway.types';
import { InvoiceService } from './invoice.service';

/** Refunds stuck in REQUESTED (gateway outcome unknown) for longer than this are retried. */
const STALE_REFUND_MS = 2 * 60 * 1000;
/** Checkout sessions never completed after this long are marked FAILED. */
const STALE_PURCHASE_MS = 24 * 60 * 60 * 1000;
/** Recent PENDING top-ups count towards limits for this long (checkout in progress). */
const PENDING_TOPUP_WINDOW_MS = 60 * 60 * 1000;

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly kyc: KycService,
    private readonly wallet: WalletService,
    private readonly invoices: InvoiceService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  listBundles() {
    return this.prisma.bundle
      .findMany({ where: { active: true }, orderBy: { priceFils: 'asc' } })
      .then((bundles) => bundles.map((b) => ({ ...b, ...addVat(b.priceFils, env.VAT_RATE_BPS) })));
  }

  async checkoutBundle(user: User, bundleCode: string, idempotencyKey: string, meta: RequestMeta) {
    await this.kyc.assertApproved(user.id);
    // Don't take money for a bundle the user cannot use: the NymCard cardholder must exist.
    await this.kyc.ensureCardholder(user.id);
    if (env.BUNDLE_MODE === 'subscription') {
      // Recurring billing needs gateway card-on-file / payment instruments — see docs/DECISIONS.md.
      throw new NotImplementedException({ code: 'SUBSCRIPTIONS_NOT_IMPLEMENTED' });
    }
    const bundle = await this.prisma.bundle.findFirst({
      where: { code: bundleCode, active: true },
    });
    if (!bundle) throw new NotFoundException({ code: 'BUNDLE_NOT_FOUND' });

    const vat = addVat(bundle.priceFils, env.VAT_RATE_BPS);
    const purchase = await this.prisma.purchase.create({
      data: {
        userId: user.id,
        type: 'BUNDLE',
        bundleId: bundle.id,
        cardQuota: bundle.cardQuota,
        subtotalFils: vat.subtotalFils,
        vatFils: vat.vatFils,
        totalFils: vat.totalFils,
        gateway: this.gateway.name,
        idempotencyKey: `purchase:${user.id}:${idempotencyKey}`,
      },
    });
    return this.startCheckout(user, purchase.id, purchase.totalFils, bundle.nameEn, meta);
  }

  /**
   * Wallet top-ups are stored value, not a supply of services, so no VAT is charged here.
   * Confirm this treatment with your tax advisor (see docs/COMPLIANCE.md).
   *
   * Stored-value limits (AML): the wallet balance may not exceed WALLET_MAX_BALANCE_FILS and
   * top-ups in any rolling 30 days may not exceed WALLET_TOPUP_30D_LIMIT_FILS.
   */
  async checkoutTopUp(user: User, amountFils: number, idempotencyKey: string, meta: RequestMeta) {
    await this.kyc.assertApproved(user.id);
    await this.assertTopUpWithinLimits(user.id, amountFils);
    const purchase = await this.prisma.purchase.create({
      data: {
        userId: user.id,
        type: 'WALLET_TOPUP',
        subtotalFils: amountFils,
        vatFils: 0,
        totalFils: amountFils,
        gateway: this.gateway.name,
        idempotencyKey: `topup:${user.id}:${idempotencyKey}`,
      },
    });
    return this.startCheckout(user, purchase.id, amountFils, 'OnlinePay wallet top-up', meta);
  }

  private async assertTopUpWithinLimits(userId: string, amountFils: number) {
    const now = Date.now();
    const [wallet, paid30d, pendingRecent] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.purchase.aggregate({
        where: {
          userId,
          type: 'WALLET_TOPUP',
          status: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
          createdAt: { gt: new Date(now - 30 * 24 * 60 * 60 * 1000) },
        },
        _sum: { totalFils: true },
      }),
      this.prisma.purchase.aggregate({
        where: {
          userId,
          type: 'WALLET_TOPUP',
          status: 'PENDING',
          createdAt: { gt: new Date(now - PENDING_TOPUP_WINDOW_MS) },
        },
        _sum: { totalFils: true },
      }),
    ]);
    const pending = pendingRecent._sum.totalFils ?? 0;
    if ((wallet?.balanceFils ?? 0) + pending + amountFils > env.WALLET_MAX_BALANCE_FILS) {
      throw new BadRequestException({
        code: 'WALLET_LIMIT_EXCEEDED',
        maxBalanceFils: env.WALLET_MAX_BALANCE_FILS,
      });
    }
    if ((paid30d._sum.totalFils ?? 0) + pending + amountFils > env.WALLET_TOPUP_30D_LIMIT_FILS) {
      throw new BadRequestException({
        code: 'TOPUP_LIMIT_EXCEEDED',
        limitFils: env.WALLET_TOPUP_30D_LIMIT_FILS,
      });
    }
  }

  private async startCheckout(
    user: User,
    purchaseId: string,
    totalFils: number,
    description: string,
    meta: RequestMeta,
  ) {
    const base = `${env.WEB_URL}/${user.locale}/checkout/result?purchase=${purchaseId}`;
    const session = await this.gateway.createCheckoutSession({
      purchaseId,
      amountFils: totalFils,
      currency: 'AED',
      description,
      customerEmail: user.email,
      successUrl: `${base}&status=success`,
      cancelUrl: `${base}&status=cancelled`,
      failureUrl: `${base}&status=failed`,
      idempotencyKey: `checkout-${purchaseId}`,
    });
    await this.prisma.purchase.update({
      where: { id: purchaseId },
      data: { gatewaySessionId: session.sessionId },
    });
    await this.audit.log({
      actorType: 'USER',
      actorId: user.id,
      action: 'purchase.checkout_started',
      targetType: 'Purchase',
      targetId: purchaseId,
      metadata: { totalFils, gateway: this.gateway.name },
      meta,
    });
    return { purchaseId, redirectUrl: session.redirectUrl };
  }

  async getPurchase(userId: string, purchaseId: string) {
    const p = await this.prisma.purchase.findFirst({
      where: { id: purchaseId, userId },
      select: {
        id: true,
        type: true,
        status: true,
        totalFils: true,
        invoice: { select: { id: true, number: true } },
      },
    });
    if (!p) throw new NotFoundException();
    return p;
  }

  /** Processes a verified gateway event. Called by the worker; safe to run more than once. */
  async handleGatewayEvent(event: GatewayEvent) {
    switch (event.type) {
      case 'payment.captured':
        return this.onCaptured(event);
      case 'payment.failed': {
        const purchase = await this.findPurchase(event.sessionId, event.reference);
        if (purchase?.status === 'PENDING') {
          await this.prisma.purchase.updateMany({
            where: { id: purchase.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });
        }
        return;
      }
      case 'refund.succeeded': {
        const refund = await this.prisma.refund.findUnique({
          where: { gatewayRefundId: event.refundId },
        });
        // The webhook can beat our own write of gatewayRefundId: throw so the job retries.
        if (!refund) throw new Error(`Unknown refund ${event.refundId}`);
        await this.prisma.refund.updateMany({
          where: { id: refund.id, status: { in: ['REQUESTED', 'PROCESSING'] } },
          data: { status: 'SUCCEEDED' },
        });
        return;
      }
      case 'refund.failed': {
        const refund = await this.prisma.refund.findUnique({
          where: { gatewayRefundId: event.refundId },
        });
        if (!refund) throw new Error(`Unknown refund ${event.refundId}`);
        await this.failRefund(refund.id, 'Refund declined by payment gateway');
        return;
      }
      default:
        return;
    }
  }

  private findPurchase(sessionId?: string, reference?: string) {
    if (sessionId) {
      return this.prisma.purchase.findUnique({
        where: { gatewaySessionId: sessionId },
        include: { bundle: true },
      });
    }
    if (reference) {
      return this.prisma.purchase.findUnique({
        where: { id: reference },
        include: { bundle: true },
      });
    }
    return Promise.resolve(null);
  }

  private async onCaptured(event: Extract<GatewayEvent, { type: 'payment.captured' }>) {
    const purchase = await this.findPurchase(event.sessionId, event.reference);
    if (!purchase) {
      this.logger.warn(`Captured payment ${event.paymentId} has no matching purchase`);
      return;
    }
    if (purchase.status === 'PAID') return; // idempotent

    const currencyOk = event.currency === undefined || event.currency === purchase.currency;
    if (event.amountFils !== purchase.totalFils || !currencyOk) {
      // Never grant value for a missing/mismatched amount or currency — flag for manual review.
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'purchase.amount_mismatch',
        targetType: 'Purchase',
        targetId: purchase.id,
        metadata: {
          expected: purchase.totalFils,
          expectedCurrency: purchase.currency,
          received: event.amountFils,
          receivedCurrency: event.currency,
        },
      });
      throw new BadRequestException('Captured amount mismatch');
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.purchase.updateMany({
        where: { id: purchase.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PAID', paidAt: new Date(), gatewayPaymentId: event.paymentId },
      });
      if (claimed.count !== 1) return; // another worker already handled it

      if (purchase.type === 'BUNDLE') {
        const description = purchase.bundle?.nameEn ?? `${purchase.cardQuota} virtual cards bundle`;
        await this.invoices.issueForPurchase(tx, purchase, description);
      } else {
        await this.wallet.credit(
          {
            userId: purchase.userId,
            amountFils: purchase.totalFils,
            type: 'TOPUP',
            idempotencyKey: `topup:${purchase.id}`,
            purchaseId: purchase.id,
          },
          tx,
        );
        if (purchase.totalFils >= env.MONITOR_HIGH_AMOUNT_FILS) {
          await tx.suspiciousActivityFlag.create({
            data: {
              userId: purchase.userId,
              rule: 'HIGH_TOPUP',
              details: {
                purchaseId: purchase.id,
                amountFils: purchase.totalFils,
                threshold: env.MONITOR_HIGH_AMOUNT_FILS,
              },
            },
          });
        }
      }
      await this.audit.log(
        {
          actorType: 'SYSTEM',
          action: 'purchase.paid',
          targetType: 'Purchase',
          targetId: purchase.id,
          metadata: { paymentId: event.paymentId },
        },
        tx,
      );
    });

    await this.notifications.notify({
      userId: purchase.userId,
      type: 'PURCHASE',
      en: {
        title: 'Payment received',
        body:
          purchase.type === 'BUNDLE'
            ? 'Your card bundle is ready to use.'
            : 'Your wallet has been topped up.',
      },
      ar: {
        title: 'تم استلام الدفعة',
        body: purchase.type === 'BUNDLE' ? 'باقة البطاقات جاهزة للاستخدام.' : 'تم شحن محفظتك.',
      },
    });
  }

  // ───────────────────────────── Refunds ─────────────────────────────

  /**
   * Admin-initiated refund to the original payment method.
   *
   * The Refund row is created first, under a per-purchase lock, so concurrent clicks cannot
   * exceed the paid amount. The wallet debit (top-ups) and the gateway idempotency key are both
   * derived from the refund id, so retries can never double-refund or double-debit. Only a
   * definite gateway rejection fails the refund and returns the money to the wallet; an unknown
   * outcome stays REQUESTED and the worker retries it with the same key.
   */
  async refund(
    purchaseId: string,
    amountFils: number,
    reason: string,
    adminId: string,
    meta: RequestMeta,
  ) {
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase:${purchaseId}`}))`;
      const purchase = await tx.purchase.findUnique({
        where: { id: purchaseId },
        include: { refunds: true },
      });
      if (!purchase || !purchase.gatewayPaymentId) throw new NotFoundException();
      if (purchase.status !== 'PAID' && purchase.status !== 'PARTIALLY_REFUNDED') {
        throw new BadRequestException({ code: 'NOT_REFUNDABLE' });
      }
      const alreadyRefunded = purchase.refunds
        .filter((r) => r.status !== 'FAILED')
        .reduce((sum, r) => sum + r.amountFils, 0);
      if (amountFils <= 0 || alreadyRefunded + amountFils > purchase.totalFils) {
        throw new BadRequestException({ code: 'REFUND_EXCEEDS_PAYMENT' });
      }
      const created = await tx.refund.create({
        data: { purchaseId, amountFils, reason, status: 'REQUESTED', createdByAdmin: adminId },
      });
      if (purchase.type === 'WALLET_TOPUP') {
        // Pull the money back out of the wallet first so it cannot be spent twice.
        await this.wallet.debit(
          {
            userId: purchase.userId,
            amountFils,
            type: 'REFUND',
            idempotencyKey: `refund-debit:${created.id}`,
            purchaseId: purchase.id,
          },
          tx,
        );
      }
      await this.audit.log(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'admin.purchase.refund',
          targetType: 'Purchase',
          targetId: purchaseId,
          metadata: { refundId: created.id, amountFils, reason },
          meta,
        },
        tx,
      );
      return created;
    });
    return this.submitRefund(refund.id);
  }

  /** Sends a REQUESTED refund to the gateway. Safe to call repeatedly. */
  async submitRefund(refundId: string) {
    const refund = await this.prisma.refund.update({
      where: { id: refundId },
      data: { attempts: { increment: 1 } },
      include: { purchase: true },
    });
    if (refund.status !== 'REQUESTED') {
      return {
        refundId: refund.id,
        gatewayRefundId: refund.gatewayRefundId,
        status: refund.status,
      };
    }
    if (!refund.purchase.gatewayPaymentId) throw new NotFoundException();

    let gatewayRefundId: string;
    try {
      ({ refundId: gatewayRefundId } = await this.gateway.refund({
        paymentId: refund.purchase.gatewayPaymentId,
        amountFils: refund.amountFils,
        reason: refund.reason,
        idempotencyKey: `refund-${refund.id}`,
      }));
    } catch (err) {
      if (err instanceof GatewayRejectedError) {
        await this.failRefund(refund.id, errorText(err));
        throw err;
      }
      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { lastError: errorText(err) },
      });
      throw new ServiceUnavailableException({ code: 'REFUND_PENDING', refundId: refund.id });
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refund.updateMany({
        where: { id: refund.id, status: 'REQUESTED' },
        data: { status: 'PROCESSING', gatewayRefundId, lastError: null },
      });
      if (claimed.count === 1) await this.recomputePurchaseStatus(tx, refund.purchaseId);
    });
    return { refundId: refund.id, gatewayRefundId, status: 'PROCESSING' as const };
  }

  /** Marks a refund FAILED and, for top-ups, returns the debited money to the wallet. Once. */
  private async failRefund(refundId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        include: { purchase: true },
      });
      const claimed = await tx.refund.updateMany({
        where: { id: refundId, status: { in: ['REQUESTED', 'PROCESSING'] } },
        data: { status: 'FAILED', lastError: reason },
      });
      if (claimed.count !== 1) return;
      if (refund.purchase.type === 'WALLET_TOPUP') {
        await this.wallet.credit(
          {
            userId: refund.purchase.userId,
            amountFils: refund.amountFils,
            type: 'ADJUSTMENT',
            idempotencyKey: `refund-reversal:${refund.id}`,
            purchaseId: refund.purchaseId,
            memo: 'Refund failed; amount returned to wallet',
          },
          tx,
        );
      }
      await this.recomputePurchaseStatus(tx, refund.purchaseId);
      await this.audit.log(
        {
          actorType: 'SYSTEM',
          action: 'purchase.refund_failed',
          targetType: 'Purchase',
          targetId: refund.purchaseId,
          metadata: { refundId, amountFils: refund.amountFils, reason },
        },
        tx,
      );
    });
  }

  private async recomputePurchaseStatus(tx: Prisma.TransactionClient, purchaseId: string) {
    const purchase = await tx.purchase.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { refunds: true },
    });
    if (!['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(purchase.status)) return;
    const refunded = purchase.refunds
      .filter((r) => r.status === 'PROCESSING' || r.status === 'SUCCEEDED')
      .reduce((sum, r) => sum + r.amountFils, 0);
    const status =
      refunded === 0 ? 'PAID' : refunded >= purchase.totalFils ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (status !== purchase.status) {
      await tx.purchase.update({ where: { id: purchaseId }, data: { status } });
    }
  }

  // ───────────────────────────── Worker maintenance ─────────────────────────────

  /** Retries refunds whose gateway outcome was unknown. */
  async resumeStaleRefunds(now = new Date()) {
    const refunds = await this.prisma.refund.findMany({
      where: { status: 'REQUESTED', updatedAt: { lt: new Date(now.getTime() - STALE_REFUND_MS) } },
      take: 100,
    });
    let resumed = 0;
    for (const refund of refunds) {
      try {
        await this.submitRefund(refund.id);
        resumed++;
      } catch (err) {
        this.logger.warn(`Resume refund ${refund.id} failed: ${errorText(err)}`);
      }
    }
    return resumed;
  }

  /** Abandoned checkouts: PENDING for a day → FAILED (a late capture still marks them PAID). */
  async expireStalePurchases(now = new Date()) {
    const res = await this.prisma.purchase.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now.getTime() - STALE_PURCHASE_MS) },
      },
      data: { status: 'FAILED' },
    });
    return res.count;
  }
}
