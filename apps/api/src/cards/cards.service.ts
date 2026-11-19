import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Card, User } from '@onlinepay/db';
import { CardAction, canPerform, computeQuota, CreateCardInput, nextStatus } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KycService } from '../kyc/kyc.service';
import { WalletService } from '../wallet/wallet.service';
import type { RequestMeta } from '../common/request';
import { env } from '../config/env';
import { NYMCARD_CLIENT, NymCardClient } from '../nymcard/nymcard.types';

export type Actor = { type: 'USER'; id: string } | { type: 'ADMIN'; id: string; reason: string };

const publicCard = (c: Card) => ({
  id: c.id,
  label: c.label,
  last4: c.last4,
  expiryMonth: c.expiryMonth,
  expiryYear: c.expiryYear,
  status: c.status,
  spendingLimitFils: c.spendingLimitFils,
  availableBalanceFils: c.availableBalanceFils,
  createdAt: c.createdAt,
  cancelledAt: c.cancelledAt,
});

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly kyc: KycService,
    private readonly wallet: WalletService,
    @Inject(NYMCARD_CLIENT) private readonly nymcard: NymCardClient,
  ) {}

  async quota(userId: string) {
    const [purchases, cards] = await Promise.all([
      this.prisma.purchase.aggregate({
        where: { userId, type: 'BUNDLE', status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        _sum: { cardQuota: true },
      }),
      this.prisma.card.findMany({ where: { userId }, select: { status: true } }),
    ]);
    return computeQuota({
      purchasedSlots: purchases._sum.cardQuota ?? 0,
      cardStatuses: cards.map((c) => c.status),
      cancelledCountsAgainstBundle: env.CANCELLED_CARDS_COUNT_AGAINST_BUNDLE,
    });
  }

  async list(userId: string) {
    const [cards, quota] = await Promise.all([
      this.prisma.card.findMany({ where: { userId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] }),
      this.quota(userId),
    ]);
    return { quota, cards: cards.map(publicCard) };
  }

  async get(userId: string, cardId: string) {
    return publicCard(await this.owned(userId, cardId));
  }

  async transactions(userId: string, cardId: string) {
    await this.owned(userId, cardId);
    return this.prisma.cardTransaction.findMany({
      where: { cardId },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
  }

  private async owned(userId: string, cardId: string) {
    const card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException({ code: 'CARD_NOT_FOUND' });
    return card;
  }

  private assertAllowed(card: Card, action: CardAction) {
    if (!canPerform(card.status, action)) {
      throw new ConflictException({ code: 'CARD_ACTION_NOT_ALLOWED', status: card.status, action });
    }
  }

  async create(user: User, input: CreateCardInput, idempotencyKey: string, meta: RequestMeta) {
    await this.kyc.assertApproved(user.id);
    if (!user.nymcardHolderId) throw new ForbiddenException({ code: 'CARDHOLDER_NOT_READY' });

    // Serialise card creation per user so concurrent requests cannot exceed the bundle quota.
    const card = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cards:${user.id}`}))`;
        const quota = await this.quota(user.id);
        if (quota.remaining <= 0) throw new ForbiddenException({ code: 'BUNDLE_EXHAUSTED', quota });

        const issued = await this.nymcard.createVirtualCard({
          cardholderId: user.nymcardHolderId!,
          label: input.label,
          idempotencyKey: `card-${user.id}-${idempotencyKey}`,
        });
        return tx.card.create({
          data: {
            userId: user.id,
            nymcardCardId: issued.id,
            label: input.label,
            last4: issued.last4,
            expiryMonth: issued.expiryMonth,
            expiryYear: issued.expiryYear,
            status: 'ACTIVE',
            availableBalanceFils: issued.balanceFils,
          },
        });
      },
      { timeout: 20_000 },
    );

    if (input.spendingLimitFils) {
      await this.setLimit({ type: 'USER', id: user.id }, user.id, card.id, input.spendingLimitFils, meta);
    }
    await this.audit.log({
      actorType: 'USER',
      actorId: user.id,
      action: 'card.create',
      targetType: 'Card',
      targetId: card.id,
      after: { label: card.label, last4: card.last4 },
      meta,
    });
    return publicCard(await this.prisma.card.findUniqueOrThrow({ where: { id: card.id } }));
  }

  async rename(userId: string, cardId: string, label: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'RENAME');
    const updated = await this.prisma.card.update({ where: { id: cardId }, data: { label } });
    await this.audit.log({
      actorType: 'USER', actorId: userId, action: 'card.rename', targetType: 'Card', targetId: cardId,
      before: { label: card.label }, after: { label }, meta,
    });
    return publicCard(updated);
  }

  async setFrozen(actor: Actor, userId: string, cardId: string, frozen: boolean, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    const action: CardAction = frozen ? 'FREEZE' : 'UNFREEZE';
    this.assertAllowed(card, action);
    const status = nextStatus(card.status, action);
    await this.nymcard.setCardStatus(card.nymcardCardId, status, actor.type === 'ADMIN' ? actor.reason : undefined);
    const updated = await this.prisma.card.update({ where: { id: cardId }, data: { status } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id, action: `card.${frozen ? 'freeze' : 'unfreeze'}`,
      targetType: 'Card', targetId: cardId, before: { status: card.status }, after: { status },
      metadata: actor.type === 'ADMIN' ? { reason: actor.reason } : undefined, meta,
    });
    await this.notifications.notify({
      userId,
      type: 'CARD_STATUS',
      en: { title: `Card ${frozen ? 'frozen' : 'unfrozen'}`, body: `Your card "${card.label}" (•••• ${card.last4}) is now ${frozen ? 'frozen' : 'active'}.` },
      ar: { title: frozen ? 'تم تجميد البطاقة' : 'تم إلغاء تجميد البطاقة', body: `بطاقتك "${card.label}" (•••• ${card.last4}) ${frozen ? 'مجمّدة الآن' : 'نشطة الآن'}.` },
    });
    return publicCard(updated);
  }

  /**
   * Permanently cancels a card. Any remaining balance is unloaded first and returned according
   * to CANCELLED_CARD_BALANCE_DESTINATION (default: the user's wallet).
   */
  async cancel(actor: Actor, userId: string, cardId: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'CANCEL');

    const issuerCard = await this.nymcard.getCard(card.nymcardCardId);
    let returnedFils = 0;
    if (issuerCard.balanceFils > 0) {
      if (env.CANCELLED_CARD_BALANCE_DESTINATION === 'source') {
        // TODO: refund-to-source needs a mapping from card loads back to gateway payments.
        throw new BadRequestException({ code: 'REFUND_TO_SOURCE_NOT_IMPLEMENTED' });
      }
      if (issuerCard.status === 'FROZEN') {
        // Some issuers block unloads on frozen cards; briefly reactivate to sweep the balance.
        await this.nymcard.setCardStatus(card.nymcardCardId, 'ACTIVE', 'sweep before cancel');
      }
      const unload = await this.nymcard.unloadFunds(card.nymcardCardId, issuerCard.balanceFils, `cancel-sweep-${card.id}`);
      returnedFils = issuerCard.balanceFils;
      await this.wallet.credit({
        userId,
        amountFils: returnedFils,
        type: 'CARD_CANCEL_RETURN',
        idempotencyKey: `cancel-return:${card.id}`,
        cardId: card.id,
        memo: `Balance returned from cancelled card •••• ${card.last4} (${unload.providerRef})`,
      });
    }

    await this.nymcard.setCardStatus(card.nymcardCardId, 'CANCELLED', actor.type === 'ADMIN' ? actor.reason : 'user request');
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), availableBalanceFils: 0 },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id, action: 'card.cancel', targetType: 'Card', targetId: cardId,
      before: { status: card.status }, after: { status: 'CANCELLED', returnedFils },
      metadata: actor.type === 'ADMIN' ? { reason: actor.reason } : undefined, meta,
    });
    await this.notifications.notify({
      userId,
      type: 'CARD_CANCELLED',
      en: { title: 'Card cancelled', body: `Your card "${card.label}" (•••• ${card.last4}) was permanently cancelled.${returnedFils ? ' Its remaining balance was returned to your wallet.' : ''}` },
      ar: { title: 'تم إلغاء البطاقة', body: `تم إلغاء بطاقتك "${card.label}" (•••• ${card.last4}) نهائياً.${returnedFils ? ' تمت إعادة الرصيد المتبقي إلى محفظتك.' : ''}` },
    });
    return { card: publicCard(updated), returnedFils };
  }

  async setLimit(actor: Actor, userId: string, cardId: string, limitFils: number | null, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'SET_LIMIT');
    await this.nymcard.setSpendingLimit(card.nymcardCardId, limitFils);
    const updated = await this.prisma.card.update({ where: { id: cardId }, data: { spendingLimitFils: limitFils } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id, action: 'card.set_limit', targetType: 'Card', targetId: cardId,
      before: { spendingLimitFils: card.spendingLimitFils }, after: { spendingLimitFils: limitFils }, meta,
    });
    return publicCard(updated);
  }

  /** Moves money from the wallet onto a card. Wallet is debited first and reversed on failure. */
  async fund(userId: string, cardId: string, amountFils: number, idempotencyKey: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'FUND');
    const key = `fund:${card.id}:${idempotencyKey}`;

    await this.wallet.debit({ userId, amountFils, type: 'CARD_FUND', idempotencyKey: key, cardId: card.id });
    try {
      const result = await this.nymcard.loadFunds(card.nymcardCardId, amountFils, key);
      await this.prisma.card.update({ where: { id: card.id }, data: { availableBalanceFils: result.balanceFils } });
      await this.audit.log({
        actorType: 'USER', actorId: userId, action: 'card.fund', targetType: 'Card', targetId: card.id,
        metadata: { amountFils, providerRef: result.providerRef }, meta,
      });
      return { balanceFils: result.balanceFils };
    } catch (err) {
      this.logger.error(`Card load failed for ${card.id}; reversing wallet debit`);
      await this.wallet.credit({
        userId, amountFils, type: 'CARD_FUND_REVERSAL', idempotencyKey: `${key}:reversal`, cardId: card.id,
      });
      throw err;
    }
  }

  /**
   * Returns a short-lived URL for NymCard's hosted secure display. PAN/CVV are rendered by the
   * issuer inside an iframe and never pass through or get stored on OnlinePay servers.
   */
  async reveal(userId: string, cardId: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'REVEAL');
    const session = await this.nymcard.createSecureDisplaySession(card.nymcardCardId);
    await this.audit.log({ actorType: 'USER', actorId: userId, action: 'card.reveal', targetType: 'Card', targetId: card.id, meta });
    return session;
  }
}
