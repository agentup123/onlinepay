import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { addVat } from '@onlinepay/shared';
import type { User } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KycService } from '../kyc/kyc.service';
import { WalletService } from '../wallet/wallet.service';
import type { RequestMeta } from '../common/request';
import { env } from '../config/env';
import { GatewayEvent, PAYMENT_GATEWAY, PaymentGateway } from './gateway.types';
import { InvoiceService } from './invoice.service';

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
   */
  async checkoutTopUp(user: User, amountFils: number, idempotencyKey: string, meta: RequestMeta) {
    await this.kyc.assertApproved(user.id);
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
          await this.prisma.purchase.update({
            where: { id: purchase.id },
            data: { status: 'FAILED' },
          });
        }
        return;
      }
      case 'refund.succeeded':
      case 'refund.failed': {
        await this.prisma.refund.updateMany({
          where: { gatewayRefundId: event.refundId },
          data: { status: event.type === 'refund.succeeded' ? 'SUCCEEDED' : 'FAILED' },
        });
        return;
      }
      default:
        return;
    }
  }

  private findPurchase(sessionId?: string, reference?: string) {
    if (sessionId)
      return this.prisma.purchase.findUnique({ where: { gatewaySessionId: sessionId } });
    if (reference) return this.prisma.purchase.findUnique({ where: { id: reference } });
    return Promise.resolve(null);
  }

  private async onCaptured(event: Extract<GatewayEvent, { type: 'payment.captured' }>) {
    const purchase = await this.findPurchase(event.sessionId, event.reference);
    if (!purchase) {
      this.logger.warn(`Captured payment ${event.paymentId} has no matching purchase`);
      return;
    }
    if (purchase.status === 'PAID') return; // idempotent
    if (event.amountFils && event.amountFils !== purchase.totalFils) {
      // Never grant value for a mismatched amount — flag for manual review instead.
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'purchase.amount_mismatch',
        targetType: 'Purchase',
        targetId: purchase.id,
        metadata: { expected: purchase.totalFils, received: event.amountFils },
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
        await this.invoices.issueForPurchase(tx, purchase, '30 virtual cards bundle');
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
            ? 'Your 30-card bundle is ready to use.'
            : 'Your wallet has been topped up.',
      },
      ar: {
        title: 'تم استلام الدفعة',
        body: purchase.type === 'BUNDLE' ? 'باقة الـ ٣٠ بطاقة جاهزة للاستخدام.' : 'تم شحن محفظتك.',
      },
    });
  }

  /** Admin-initiated refund to the original payment method. */
  async refund(
    purchaseId: string,
    amountFils: number,
    reason: string,
    adminId: string,
    meta: RequestMeta,
  ) {
    const purchase = await this.prisma.purchase.findUnique({
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
    if (purchase.type === 'WALLET_TOPUP') {
      // Pull the money back out of the wallet first so it cannot be spent twice.
      await this.wallet.debit({
        userId: purchase.userId,
        amountFils,
        type: 'REFUND',
        idempotencyKey: `refund-debit:${purchase.id}:${alreadyRefunded}`,
        purchaseId: purchase.id,
      });
    }

    const { refundId } = await this.gateway.refund({
      paymentId: purchase.gatewayPaymentId,
      amountFils,
      reason,
      idempotencyKey: `refund-${purchase.id}-${randomUUID()}`,
    });
    const fullyRefunded = alreadyRefunded + amountFils === purchase.totalFils;
    await this.prisma.$transaction([
      this.prisma.refund.create({
        data: {
          purchaseId,
          amountFils,
          reason,
          status: 'PROCESSING',
          gatewayRefundId: refundId,
          createdByAdmin: adminId,
        },
      }),
      this.prisma.purchase.update({
        where: { id: purchaseId },
        data: { status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      }),
    ]);
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'admin.purchase.refund',
      targetType: 'Purchase',
      targetId: purchaseId,
      metadata: { amountFils, reason, refundId },
      meta,
    });
    return { refundId, status: 'PROCESSING' };
  }
}
