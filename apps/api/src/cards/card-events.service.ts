import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@onlinepay/db';
import type { CardTxnStatus, CardTxnType } from '@onlinepay/db';
import { formatFils } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { env } from '../config/env';
import { evaluateRules } from '../monitoring/monitoring.rules';
import type { NymCardEvent } from '../nymcard/nymcard.types';

const STATUS_BY_STAGE: Record<CardTxnType, CardTxnStatus> = {
  AUTHORIZATION: 'PENDING',
  SETTLEMENT: 'SETTLED',
  REVERSAL: 'REVERSED',
  REFUND: 'SETTLED',
  DECLINE: 'DECLINED',
};

/** Applies normalised NymCard events to our database. Idempotent per transaction id. */
@Injectable()
export class CardEventsService {
  private readonly logger = new Logger(CardEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async apply(event: NymCardEvent): Promise<void> {
    if (event.kind === 'unknown') {
      this.logger.warn(`Ignoring unknown NymCard event type ${event.type}`);
      return;
    }
    const card = await this.prisma.card.findUnique({ where: { nymcardCardId: event.cardId } });
    if (!card) {
      // Throw so the job retries: the event may arrive before our card row is committed.
      throw new Error(`Unknown card ${event.cardId}`);
    }

    if (event.kind === 'card_status') {
      if (card.status === event.status || card.status === 'CANCELLED') return;
      await this.prisma.card.update({
        where: { id: card.id },
        data: {
          status: event.status,
          cancelledAt: event.status === 'CANCELLED' ? new Date() : undefined,
        },
      });
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'card.status_synced',
        targetType: 'Card',
        targetId: card.id,
        before: { status: card.status },
        after: { status: event.status },
      });
      return;
    }

    // ── Transaction events ──
    const type = event.stage as CardTxnType;
    const status = STATUS_BY_STAGE[type];
    const existing = await this.prisma.cardTransaction.findUnique({
      where: { providerTxnId: event.transactionId },
    });
    // Do not move a settled/reversed transaction back to pending if events arrive out of order.
    if (existing && existing.status !== 'PENDING' && status === 'PENDING') return;

    const data = {
      type,
      status,
      amountFils: event.amountFils,
      originalAmount: event.originalAmount,
      originalCurrency: event.originalCurrency,
      merchantName: event.merchantName,
      merchantCountry: event.merchantCountry,
      mcc: event.mcc,
      declineReason: event.declineReason,
      occurredAt: new Date(event.occurredAt),
    };
    await this.prisma.cardTransaction.upsert({
      where: { providerTxnId: event.transactionId },
      update: data,
      create: { ...data, cardId: card.id, providerTxnId: event.transactionId },
    });
    if (event.availableBalanceFils !== undefined) {
      await this.prisma.card.update({
        where: { id: card.id },
        data: { availableBalanceFils: event.availableBalanceFils },
      });
    }

    if (!existing && (type === 'AUTHORIZATION' || type === 'DECLINE')) {
      const amount = formatFils(event.amountFils);
      const merchant = event.merchantName ?? 'a merchant';
      await this.notifications.notify({
        userId: card.userId,
        type: type === 'DECLINE' ? 'DECLINE' : 'TRANSACTION',
        email: type === 'DECLINE',
        en:
          type === 'DECLINE'
            ? {
                title: 'Payment declined',
                body: `${amount} at ${merchant} on "${card.label}" was declined${event.declineReason ? `: ${event.declineReason}` : ''}.`,
              }
            : { title: 'New transaction', body: `${amount} at ${merchant} on "${card.label}".` },
        ar:
          type === 'DECLINE'
            ? {
                title: 'تم رفض الدفعة',
                body: `تم رفض ${formatFils(event.amountFils, 'ar')} لدى ${merchant} على البطاقة "${card.label}".`,
              }
            : {
                title: 'معاملة جديدة',
                body: `${formatFils(event.amountFils, 'ar')} لدى ${merchant} على البطاقة "${card.label}".`,
              },
      });
    }

    if (!existing) await this.monitor(card.id, card.userId, type, event.amountFils, event.mcc);
  }

  private async monitor(
    cardId: string,
    userId: string,
    stage: CardTxnType,
    amountFils: number,
    mcc?: string,
  ) {
    const cardIds = (
      await this.prisma.card.findMany({ where: { userId }, select: { id: true } })
    ).map((c) => c.id);
    const [authsLast10Min, declinesLastHour] = await Promise.all([
      this.prisma.cardTransaction.count({
        where: {
          cardId: { in: cardIds },
          type: 'AUTHORIZATION',
          createdAt: { gt: new Date(Date.now() - 10 * 60_000) },
        },
      }),
      this.prisma.cardTransaction.count({
        where: {
          cardId: { in: cardIds },
          type: 'DECLINE',
          createdAt: { gt: new Date(Date.now() - 60 * 60_000) },
        },
      }),
    ]);
    const hits = evaluateRules(
      { amountFils, mcc, stage, authsLast10Min, declinesLastHour },
      {
        highAmountFils: env.MONITOR_HIGH_AMOUNT_FILS,
        velocityCount: env.MONITOR_VELOCITY_COUNT,
        declineCount: env.MONITOR_DECLINE_COUNT,
        riskyMccs: env.MONITOR_RISKY_MCCS,
      },
    );
    for (const hit of hits) {
      await this.prisma.suspiciousActivityFlag.create({
        data: { userId, cardId, rule: hit.rule, details: hit.details as Prisma.InputJsonValue },
      });
    }
  }
}
