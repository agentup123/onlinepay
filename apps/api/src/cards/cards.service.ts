import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Card, CardCancellation, Prisma, User } from '@onlinepay/db';
import {
  CardAction,
  canPerform,
  computeQuota,
  CreateCardInput,
  nextStatus,
} from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KycService } from '../kyc/kyc.service';
import { WalletService } from '../wallet/wallet.service';
import type { RequestMeta } from '../common/request';
import { env } from '../config/env';
import {
  IssuerRejectedError,
  NYMCARD_CLIENT,
  NymCardClient,
  type IssuerCard,
} from '../nymcard/nymcard.types';

export type Actor =
  | { type: 'USER'; id: string }
  | { type: 'ADMIN'; id: string; reason: string }
  | { type: 'SYSTEM'; reason: string };

type Db = Prisma.TransactionClient | PrismaService;

/** Operations stuck in a non-final state for longer than this are resumed by the worker. */
export const STALE_OPERATION_MS = 2 * 60 * 1000;

const OPEN_OPERATION = ['PENDING', 'UNKNOWN'] as const;

const publicCard = (c: Card) => ({
  id: c.id,
  label: c.label,
  last4: c.last4,
  expiryMonth: c.expiryMonth,
  expiryYear: c.expiryYear,
  status: c.status,
  frozenBy: c.frozenBy,
  spendingLimitFils: c.spendingLimitFils,
  availableBalanceFils: c.availableBalanceFils,
  createdAt: c.createdAt,
  cancelledAt: c.cancelledAt,
});

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

const actorId = (actor: Actor) => (actor.type === 'SYSTEM' ? null : actor.id);
const actorReason = (actor: Actor) => (actor.type === 'USER' ? undefined : actor.reason);

/** Serialises every state-changing operation on one card (fund, cancel, freeze). */
async function lockCard(tx: Prisma.TransactionClient, cardId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`card:${cardId}`}))`;
}

/** Serialises card issuance per user so concurrent requests cannot exceed the bundle quota. */
async function lockUserCards(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cards:${userId}`}))`;
}

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

  async quota(userId: string, db: Db = this.prisma) {
    const [purchases, cards, pendingIssuances] = await Promise.all([
      db.purchase.aggregate({
        where: { userId, type: 'BUNDLE', status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        _sum: { cardQuota: true },
      }),
      db.card.findMany({ where: { userId }, select: { status: true } }),
      db.cardIssuance.count({ where: { userId, status: { in: [...OPEN_OPERATION] } } }),
    ]);
    return computeQuota({
      purchasedSlots: purchases._sum.cardQuota ?? 0,
      cardStatuses: cards.map((c) => c.status),
      cancelledCountsAgainstBundle: env.CANCELLED_CARDS_COUNT_AGAINST_BUNDLE,
      pendingIssuances,
    });
  }

  async list(userId: string) {
    const [cards, quota] = await Promise.all([
      this.prisma.card.findMany({
        where: { userId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      }),
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

  private async owned(userId: string, cardId: string, db: Db = this.prisma) {
    const card = await db.card.findFirst({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException({ code: 'CARD_NOT_FOUND' });
    return card;
  }

  private assertAllowed(card: Card, action: CardAction) {
    if (!canPerform(card.status, action)) {
      throw new ConflictException({
        code: 'CARD_ACTION_NOT_ALLOWED',
        status: card.status,
        action,
      });
    }
  }

  /** A card with a cancellation in progress accepts no other state change. */
  private async assertNotCancelling(db: Db, cardId: string) {
    const cancellation = await db.cardCancellation.findUnique({ where: { cardId } });
    if (cancellation) throw new ConflictException({ code: 'CARD_CANCELLATION_IN_PROGRESS' });
  }

  // ───────────────────────────── Issuance ─────────────────────────────

  /**
   * Issues a card. The bundle slot is reserved by a CardIssuance row committed BEFORE NymCard is
   * called, so no DB transaction is held open across the network call and a crash can never leave
   * an issued card without a record: the worker resumes PENDING/UNKNOWN issuances with the same
   * issuer idempotency key.
   */
  async create(user: User, input: CreateCardInput, idempotencyKey: string, meta: RequestMeta) {
    await this.kyc.assertApproved(user.id);
    const holderId = await this.kyc.ensureCardholder(user.id);
    const key = `${user.id}:${idempotencyKey}`;
    const limit = input.spendingLimitFils ?? null;

    const issuance = await this.prisma.$transaction(async (tx) => {
      await lockUserCards(tx, user.id);
      const existing = await tx.cardIssuance.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (existing.label !== input.label || existing.spendingLimitFils !== limit) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return existing;
      }
      const quota = await this.quota(user.id, tx);
      if (quota.remaining <= 0) throw new ForbiddenException({ code: 'BUNDLE_EXHAUSTED', quota });
      return tx.cardIssuance.create({
        data: {
          userId: user.id,
          idempotencyKey: key,
          label: input.label,
          spendingLimitFils: limit,
        },
      });
    });

    if (issuance.status === 'FAILED') {
      throw new ConflictException({ code: 'CARD_ISSUANCE_FAILED', reason: issuance.lastError });
    }
    const card =
      issuance.status === 'SUCCEEDED' && issuance.cardId
        ? await this.prisma.card.findUniqueOrThrow({ where: { id: issuance.cardId } })
        : await this.executeIssuance(issuance.id, holderId);

    const fresh = issuance.status !== 'SUCCEEDED';
    if (fresh && limit) {
      // Best effort: the card exists either way. Failing the request here would make the client
      // retry with a new key and burn a second bundle slot.
      try {
        await this.setLimit({ type: 'USER', id: user.id }, user.id, card.id, limit, meta);
      } catch (err) {
        this.logger.warn(`Spending limit not applied to new card ${card.id}: ${errorText(err)}`);
      }
    }
    if (fresh) {
      await this.audit.log({
        actorType: 'USER',
        actorId: user.id,
        action: 'card.create',
        targetType: 'Card',
        targetId: card.id,
        after: { label: card.label, last4: card.last4 },
        meta,
      });
    }
    return publicCard(await this.prisma.card.findUniqueOrThrow({ where: { id: card.id } }));
  }

  /** Calls NymCard for an issuance and records the outcome. Safe to call repeatedly. */
  async executeIssuance(issuanceId: string, holderId: string): Promise<Card> {
    const issuance = await this.prisma.cardIssuance.update({
      where: { id: issuanceId },
      data: { attempts: { increment: 1 } },
    });
    let issued: IssuerCard;
    try {
      issued = await this.nymcard.createVirtualCard({
        cardholderId: holderId,
        label: issuance.label,
        idempotencyKey: `issue-${issuance.id}`,
      });
    } catch (err) {
      await this.prisma.cardIssuance.updateMany({
        where: { id: issuance.id, status: { in: [...OPEN_OPERATION] } },
        data: {
          status: err instanceof IssuerRejectedError ? 'FAILED' : 'UNKNOWN',
          lastError: errorText(err),
        },
      });
      throw err;
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.cardIssuance.updateMany({
        where: { id: issuance.id, status: { in: [...OPEN_OPERATION] } },
        data: { status: 'SUCCEEDED', lastError: null },
      });
      if (claimed.count !== 1) {
        // Another request/worker finalised it first.
        const done = await tx.cardIssuance.findUniqueOrThrow({ where: { id: issuance.id } });
        if (done.cardId) return tx.card.findUniqueOrThrow({ where: { id: done.cardId } });
        throw new ConflictException({ code: 'CARD_ISSUANCE_FAILED', reason: done.lastError });
      }
      const card = await tx.card.create({
        data: {
          userId: issuance.userId,
          nymcardCardId: issued.id,
          label: issuance.label,
          last4: issued.last4,
          expiryMonth: issued.expiryMonth,
          expiryYear: issued.expiryYear,
          status: 'ACTIVE',
          availableBalanceFils: issued.balanceFils,
          balanceAsOf: new Date(),
        },
      });
      await tx.cardIssuance.update({ where: { id: issuance.id }, data: { cardId: card.id } });
      return card;
    });
  }

  // ───────────────────────────── Simple card actions ─────────────────────────────

  async rename(userId: string, cardId: string, label: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'RENAME');
    const updated = await this.prisma.card.update({ where: { id: cardId }, data: { label } });
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'card.rename',
      targetType: 'Card',
      targetId: cardId,
      before: { label: card.label },
      after: { label },
      meta,
    });
    return publicCard(updated);
  }

  /**
   * Freezes/unfreezes a card. Freezes remember who applied them: a cardholder can never lift a
   * freeze applied by an admin (compliance), and an admin freeze on a card the user had already
   * frozen escalates it to an admin freeze.
   */
  async setFrozen(
    actor: Exclude<Actor, { type: 'SYSTEM' }>,
    userId: string,
    cardId: string,
    frozen: boolean,
    meta: RequestMeta,
  ) {
    const card = await this.owned(userId, cardId);
    await this.assertNotCancelling(this.prisma, card.id);

    if (frozen && actor.type === 'ADMIN' && card.status === 'FROZEN') {
      if (card.frozenBy === 'ADMIN') return publicCard(card);
      const escalated = await this.prisma.card.update({
        where: { id: card.id },
        data: { frozenBy: 'ADMIN' },
      });
      await this.audit.log({
        actorType: 'ADMIN',
        actorId: actor.id,
        action: 'card.freeze',
        targetType: 'Card',
        targetId: cardId,
        before: { status: card.status, frozenBy: card.frozenBy },
        after: { status: card.status, frozenBy: 'ADMIN' },
        metadata: { reason: actor.reason },
        meta,
      });
      return publicCard(escalated);
    }

    const action: CardAction = frozen ? 'FREEZE' : 'UNFREEZE';
    this.assertAllowed(card, action);
    if (!frozen && actor.type === 'USER' && card.frozenBy === 'ADMIN') {
      throw new ForbiddenException({ code: 'CARD_FROZEN_BY_ADMIN' });
    }
    const status = nextStatus(card.status, action);
    await this.nymcard.setCardStatus(card.nymcardCardId, status, actorReason(actor));

    // Conditional update: if the card changed underneath us (e.g. it was cancelled) we must not
    // resurrect it. The target status is accepted too: the issuer's webhook for this very change
    // may already have been applied.
    const result = await this.prisma.card.updateMany({
      where: { id: cardId, status: { in: [card.status, status] } },
      data: { status, frozenBy: frozen ? actor.type : null, statusChangedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictException({ code: 'CARD_STATE_CHANGED' });
    const updated = await this.prisma.card.findUniqueOrThrow({ where: { id: cardId } });

    await this.audit.log({
      actorType: actor.type,
      actorId: actor.id,
      action: `card.${frozen ? 'freeze' : 'unfreeze'}`,
      targetType: 'Card',
      targetId: cardId,
      before: { status: card.status, frozenBy: card.frozenBy },
      after: { status, frozenBy: updated.frozenBy },
      metadata: actor.type === 'ADMIN' ? { reason: actor.reason } : undefined,
      meta,
    });
    await this.notifications.notify({
      userId,
      type: 'CARD_STATUS',
      en: {
        title: `Card ${frozen ? 'frozen' : 'unfrozen'}`,
        body: `Your card "${card.label}" (•••• ${card.last4}) is now ${frozen ? 'frozen' : 'active'}.`,
      },
      ar: {
        title: frozen ? 'تم تجميد البطاقة' : 'تم إلغاء تجميد البطاقة',
        body: `بطاقتك "${card.label}" (•••• ${card.last4}) ${frozen ? 'مجمّدة الآن' : 'نشطة الآن'}.`,
      },
    });
    return publicCard(updated);
  }

  /**
   * Admin freeze of every live card of a user (used on suspension). Returns the cards that could
   * not be frozen so the caller can surface them; the rest are frozen even if one fails.
   */
  async freezeAllForUser(
    actor: Extract<Actor, { type: 'ADMIN' }>,
    userId: string,
    meta: RequestMeta,
  ) {
    const cards = await this.prisma.card.findMany({
      where: { userId, status: { not: 'CANCELLED' } },
    });
    const failed: { cardId: string; error: string }[] = [];
    for (const card of cards) {
      try {
        await this.setFrozen(actor, userId, card.id, true, meta);
      } catch (err) {
        failed.push({ cardId: card.id, error: errorText(err) });
      }
    }
    return { frozen: cards.length - failed.length, failed };
  }

  async setLimit(
    actor: Exclude<Actor, { type: 'SYSTEM' }>,
    userId: string,
    cardId: string,
    limitFils: number | null,
    meta: RequestMeta,
  ) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'SET_LIMIT');
    await this.nymcard.setSpendingLimit(card.nymcardCardId, limitFils);
    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: { spendingLimitFils: limitFils },
    });
    await this.audit.log({
      actorType: actor.type,
      actorId: actor.id,
      action: 'card.set_limit',
      targetType: 'Card',
      targetId: cardId,
      before: { spendingLimitFils: card.spendingLimitFils },
      after: { spendingLimitFils: limitFils },
      meta,
    });
    return publicCard(updated);
  }

  // ───────────────────────────── Funding ─────────────────────────────

  /**
   * Moves money from the wallet onto a card.
   *
   * 1. Under the card lock: record a CardFunding (keyed by the client's Idempotency-Key) and debit
   *    the wallet in the same transaction.
   * 2. Call NymCard with an issuer idempotency key derived from the funding id.
   * 3. Only a definite issuer rejection marks it FAILED and refunds the wallet. A timeout/5xx
   *    leaves it UNKNOWN; the same request (or the worker) retries with the same issuer key.
   *
   * A replay with the same key but a different amount is rejected, so a failed attempt can never
   * be "retried" into a larger, unpaid load.
   */
  async fund(
    userId: string,
    cardId: string,
    amountFils: number,
    idempotencyKey: string,
    meta: RequestMeta,
  ) {
    const key = `${cardId}:${idempotencyKey}`;
    const funding = await this.prisma.$transaction(async (tx) => {
      await lockCard(tx, cardId);
      const card = await this.owned(userId, cardId, tx);
      const existing = await tx.cardFunding.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (existing.amountFils !== amountFils || existing.userId !== userId) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return existing;
      }
      this.assertAllowed(card, 'FUND');
      await this.assertNotCancelling(tx, card.id);
      const created = await tx.cardFunding.create({
        data: { userId, cardId, amountFils, idempotencyKey: key },
      });
      await this.wallet.debit(
        {
          userId,
          amountFils,
          type: 'CARD_FUND',
          idempotencyKey: `fund:${created.id}`,
          cardId,
        },
        tx,
      );
      return created;
    });

    if (funding.status === 'FAILED') {
      throw new ConflictException({ code: 'CARD_FUNDING_FAILED', reason: funding.lastError });
    }
    if (funding.status === 'SUCCEEDED') {
      const card = await this.prisma.card.findUniqueOrThrow({ where: { id: cardId } });
      return { status: 'SUCCEEDED' as const, balanceFils: card.availableBalanceFils };
    }
    return this.executeFunding(funding.id, meta);
  }

  /** Loads the card at NymCard for a recorded funding and settles it. Safe to call repeatedly. */
  async executeFunding(fundingId: string, meta?: RequestMeta) {
    const funding = await this.prisma.cardFunding.update({
      where: { id: fundingId },
      data: { attempts: { increment: 1 } },
      include: { card: true },
    });
    if (funding.status === 'SUCCEEDED' || funding.status === 'FAILED') {
      return { status: funding.status, balanceFils: funding.card.availableBalanceFils };
    }

    let result: { providerRef: string; balanceFils: number };
    try {
      result = await this.nymcard.loadFunds(
        funding.card.nymcardCardId,
        funding.amountFils,
        `fund-${funding.id}`,
      );
    } catch (err) {
      if (err instanceof IssuerRejectedError) {
        await this.failFunding(funding.id, errorText(err));
        throw err;
      }
      await this.prisma.cardFunding.updateMany({
        where: { id: funding.id, status: { in: [...OPEN_OPERATION] } },
        data: { status: 'UNKNOWN', lastError: errorText(err) },
      });
      this.logger.warn(`Card load outcome unknown for funding ${funding.id}; will retry`);
      throw new ServiceUnavailableException({
        code: 'CARD_FUNDING_PENDING',
        fundingId: funding.id,
      });
    }

    const claimed = await this.prisma.cardFunding.updateMany({
      where: { id: funding.id, status: { in: [...OPEN_OPERATION] } },
      data: { status: 'SUCCEEDED', providerRef: result.providerRef, lastError: null },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.cardFunding.findUniqueOrThrow({
        where: { id: funding.id },
      });
      if (current.status === 'FAILED') {
        // The issuer loaded the card after we had already refunded the wallet. This must never
        // happen with a correctly idempotent issuer; surface it loudly for ops instead of
        // silently creating money.
        this.logger.error(`Funding ${funding.id} loaded at issuer after being marked FAILED`);
        await this.prisma.suspiciousActivityFlag.create({
          data: {
            userId: funding.userId,
            cardId: funding.cardId,
            rule: 'FUNDING_INCONSISTENT',
            details: {
              fundingId: funding.id,
              amountFils: funding.amountFils,
              providerRef: result.providerRef,
            },
          },
        });
      }
    }

    // Display-only cache; deliberately outside anything that could trigger compensation.
    try {
      await this.prisma.card.update({
        where: { id: funding.cardId },
        data: { availableBalanceFils: result.balanceFils, balanceAsOf: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Could not cache balance for card ${funding.cardId}: ${errorText(err)}`);
    }
    if (claimed.count === 1) {
      await this.audit.log({
        actorType: 'USER',
        actorId: funding.userId,
        action: 'card.fund',
        targetType: 'Card',
        targetId: funding.cardId,
        metadata: {
          fundingId: funding.id,
          amountFils: funding.amountFils,
          providerRef: result.providerRef,
        },
        meta,
      });
    }
    return { status: 'SUCCEEDED' as const, balanceFils: result.balanceFils };
  }

  /** Definite issuer rejection: mark FAILED and return the money to the wallet, exactly once. */
  private async failFunding(fundingId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const funding = await tx.cardFunding.findUniqueOrThrow({ where: { id: fundingId } });
      const claimed = await tx.cardFunding.updateMany({
        where: { id: fundingId, status: { in: [...OPEN_OPERATION] } },
        data: { status: 'FAILED', lastError: reason },
      });
      if (claimed.count !== 1) return;
      await this.wallet.credit(
        {
          userId: funding.userId,
          amountFils: funding.amountFils,
          type: 'CARD_FUND_REVERSAL',
          idempotencyKey: `fund-reversal:${funding.id}`,
          cardId: funding.cardId,
          memo: 'Card load rejected by issuer',
        },
        tx,
      );
      await this.audit.log(
        {
          actorType: 'SYSTEM',
          action: 'wallet.card_fund_reversed',
          targetType: 'Card',
          targetId: funding.cardId,
          metadata: { fundingId, amountFils: funding.amountFils, reason },
        },
        tx,
      );
    });
  }

  // ───────────────────────────── Cancellation ─────────────────────────────

  /**
   * Permanently cancels a card, returning any balance to the wallet. Progress is persisted in a
   * CardCancellation row (PENDING → SWEEPING → SWEPT → COMPLETED) so a crash at any point resumes
   * without losing or double-crediting the balance.
   */
  async cancel(actor: Actor, userId: string, cardId: string, meta: RequestMeta) {
    if (env.CANCELLED_CARD_BALANCE_DESTINATION === 'source') {
      // TODO: refund-to-source needs a mapping from card loads back to gateway payments.
      const card = await this.owned(userId, cardId);
      const remote = await this.nymcard.getCard(card.nymcardCardId);
      if (remote.balanceFils > 0) {
        throw new BadRequestException({ code: 'REFUND_TO_SOURCE_NOT_IMPLEMENTED' });
      }
    }

    const cancellation = await this.prisma.$transaction(async (tx) => {
      await lockCard(tx, cardId);
      const card = await this.owned(userId, cardId, tx);
      const existing = await tx.cardCancellation.findUnique({ where: { cardId } });
      if (existing) return existing; // resume
      this.assertAllowed(card, 'CANCEL');
      if (actor.type === 'USER' && card.frozenBy === 'ADMIN') {
        // Cancelling would sweep a compliance-frozen balance into the wallet.
        throw new ForbiddenException({ code: 'CARD_FROZEN_BY_ADMIN' });
      }
      const inflight = await tx.cardFunding.count({
        where: { cardId, status: { in: [...OPEN_OPERATION] } },
      });
      if (inflight > 0) throw new ConflictException({ code: 'CARD_OPERATION_IN_PROGRESS' });
      return tx.cardCancellation.create({
        data: {
          cardId,
          userId,
          requestedByType: actor.type,
          requestedById: actorId(actor),
          reason: actorReason(actor) ?? 'user request',
        },
      });
    });

    return this.executeCancellation(cancellation.id, actor, meta);
  }

  /** Drives a cancellation to COMPLETED from whatever step it reached. Safe to call repeatedly. */
  async executeCancellation(cancellationId: string, actor: Actor, meta?: RequestMeta) {
    let c: CardCancellation & { card: Card } = await this.prisma.cardCancellation.update({
      where: { id: cancellationId },
      data: { attempts: { increment: 1 } },
      include: { card: true },
    });
    const card = c.card;

    try {
      if (c.status === 'PENDING') {
        // Stop new spend first so the balance we read is the balance we sweep.
        const remote = await this.nymcard.getCard(card.nymcardCardId);
        if (remote.status === 'ACTIVE') {
          await this.nymcard.setCardStatus(card.nymcardCardId, 'FROZEN', 'cancellation');
        }
        let balance =
          remote.status === 'ACTIVE'
            ? (await this.nymcard.getCard(card.nymcardCardId)).balanceFils
            : remote.balanceFils;
        if (remote.status === 'CANCELLED' && balance > 0) {
          // Already cancelled at the issuer: funds can no longer be unloaded by us. Hand it to
          // ops (issuer-side refund) instead of retrying forever.
          await this.prisma.suspiciousActivityFlag.create({
            data: {
              userId: c.userId,
              cardId: card.id,
              rule: 'ISSUER_CANCELLED_WITH_BALANCE',
              details: { balanceFils: balance, cancellationId: c.id },
            },
          });
          balance = 0;
        }
        c = await this.prisma.cardCancellation.update({
          where: { id: c.id },
          data: { status: 'SWEEPING', sweepFils: Math.max(0, balance), lastError: null },
          include: { card: true },
        });
      }

      if (c.status === 'SWEEPING') {
        const amount = c.sweepFils ?? 0;
        let unloadRef: string | null = null;
        if (amount > 0) {
          unloadRef = await this.unloadForCancellation(card, amount);
        }
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.cardCancellation.updateMany({
            where: { id: c.id, status: 'SWEEPING' },
            data: { status: 'SWEPT', unloadRef },
          });
          if (claimed.count !== 1 || amount <= 0) return;
          await this.wallet.credit(
            {
              userId: c.userId,
              amountFils: amount,
              type: 'CARD_CANCEL_RETURN',
              idempotencyKey: `cancel-return:${card.id}`,
              cardId: card.id,
              memo: `Balance returned from cancelled card •••• ${card.last4} (${unloadRef})`,
            },
            tx,
          );
          await this.audit.log(
            {
              actorType: 'SYSTEM',
              action: 'wallet.card_cancel_return',
              targetType: 'Card',
              targetId: card.id,
              metadata: { amountFils: amount, unloadRef, cancellationId: c.id },
            },
            tx,
          );
        });
        c = await this.prisma.cardCancellation.findUniqueOrThrow({
          where: { id: c.id },
          include: { card: true },
        });
      }

      if (c.status === 'SWEPT') {
        const remote = await this.nymcard.getCard(card.nymcardCardId);
        if (remote.status !== 'CANCELLED') {
          await this.nymcard.setCardStatus(
            card.nymcardCardId,
            'CANCELLED',
            actorReason(actor) ?? 'user request',
          );
        }
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.cardCancellation.updateMany({
            where: { id: c.id, status: 'SWEPT' },
            data: { status: 'COMPLETED', lastError: null },
          });
          if (claimed.count !== 1) return;
          await tx.card.update({
            where: { id: card.id },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              statusChangedAt: new Date(),
              availableBalanceFils: 0,
              balanceAsOf: new Date(),
              frozenBy: null,
            },
          });
          await this.audit.log(
            {
              actorType: actor.type,
              actorId: actorId(actor),
              action: 'card.cancel',
              targetType: 'Card',
              targetId: card.id,
              before: { status: card.status },
              after: { status: 'CANCELLED', returnedFils: c.sweepFils ?? 0 },
              metadata: actor.type === 'USER' ? undefined : { reason: actor.reason },
              meta,
            },
            tx,
          );
        });
        const returnedFils = c.sweepFils ?? 0;
        await this.notifications.notify({
          userId: c.userId,
          type: 'CARD_CANCELLED',
          en: {
            title: 'Card cancelled',
            body: `Your card "${card.label}" (•••• ${card.last4}) was permanently cancelled.${returnedFils ? ' Its remaining balance was returned to your wallet.' : ''}`,
          },
          ar: {
            title: 'تم إلغاء البطاقة',
            body: `تم إلغاء بطاقتك "${card.label}" (•••• ${card.last4}) نهائياً.${returnedFils ? ' تمت إعادة الرصيد المتبقي إلى محفظتك.' : ''}`,
          },
        });
      }
    } catch (err) {
      await this.prisma.cardCancellation.update({
        where: { id: c.id },
        data: { lastError: errorText(err) },
      });
      throw err;
    }

    const final = await this.prisma.cardCancellation.findUniqueOrThrow({
      where: { id: c.id },
      include: { card: true },
    });
    return { card: publicCard(final.card), returnedFils: final.sweepFils ?? 0 };
  }

  /**
   * Unloads the recorded balance with a stable issuer idempotency key (a retry after a crash
   * returns the original result). If the issuer refuses unloads on frozen cards, the card is
   * briefly reactivated for the sweep.
   */
  private async unloadForCancellation(card: Card, amount: number) {
    // The key includes the amount: a stable key for a retry of the same sweep, and a fresh one
    // if the balance had to be re-read.
    const key = `cancel-sweep-${card.id}-${amount}`;
    try {
      return (await this.nymcard.unloadFunds(card.nymcardCardId, amount, key)).providerRef;
    } catch (err) {
      if (!(err instanceof IssuerRejectedError)) throw err;
    }
    // Rejected: possibly because the issuer blocks unloads on frozen cards. Retry on an active
    // card under a second stable key (on a resumed attempt this replays the earlier result).
    try {
      const remote = await this.nymcard.getCard(card.nymcardCardId);
      if (remote.status === 'FROZEN') {
        await this.nymcard.setCardStatus(card.nymcardCardId, 'ACTIVE', 'sweep before cancel');
      }
      return (await this.nymcard.unloadFunds(card.nymcardCardId, amount, `${key}-active`))
        .providerRef;
    } catch (err) {
      if (!(err instanceof IssuerRejectedError)) throw err;
      // e.g. the balance changed (late authorization): re-read it on the next attempt.
      await this.prisma.cardCancellation.updateMany({
        where: { cardId: card.id, status: 'SWEEPING' },
        data: { status: 'PENDING', lastError: errorText(err) },
      });
      throw new ConflictException({ code: 'CARD_CANCELLATION_RETRY' });
    }
  }

  // ───────────────────────────── Reveal ─────────────────────────────

  /**
   * Returns a short-lived URL for NymCard's hosted secure display. PAN/CVV are rendered by the
   * issuer inside an iframe and never pass through or get stored on OnlinePay servers.
   */
  async reveal(userId: string, cardId: string, meta: RequestMeta) {
    const card = await this.owned(userId, cardId);
    this.assertAllowed(card, 'REVEAL');
    const session = await this.nymcard.createSecureDisplaySession(card.nymcardCardId);
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'card.reveal',
      targetType: 'Card',
      targetId: card.id,
      meta,
    });
    return session;
  }

  // ───────────────────────────── Worker: resume stuck operations ─────────────────────────────

  /** Resumes issuances, fundings and cancellations that were interrupted. Called by the worker. */
  async resumeStaleOperations(now = new Date()) {
    const before = new Date(now.getTime() - STALE_OPERATION_MS);
    const summary = { issuances: 0, fundings: 0, cancellations: 0, errors: 0 };

    const issuances = await this.prisma.cardIssuance.findMany({
      where: { status: { in: [...OPEN_OPERATION] }, updatedAt: { lt: before } },
      take: 100,
    });
    for (const issuance of issuances) {
      try {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: issuance.userId } });
        if (!user.nymcardHolderId) continue;
        await this.executeIssuance(issuance.id, user.nymcardHolderId);
        summary.issuances++;
      } catch (err) {
        summary.errors++;
        this.logger.warn(`Resume issuance ${issuance.id} failed: ${errorText(err)}`);
      }
    }

    const fundings = await this.prisma.cardFunding.findMany({
      where: { status: { in: [...OPEN_OPERATION] }, updatedAt: { lt: before } },
      take: 100,
    });
    for (const funding of fundings) {
      try {
        await this.executeFunding(funding.id);
        summary.fundings++;
      } catch (err) {
        summary.errors++;
        this.logger.warn(`Resume funding ${funding.id} failed: ${errorText(err)}`);
      }
    }

    const cancellations = await this.prisma.cardCancellation.findMany({
      where: { status: { not: 'COMPLETED' }, updatedAt: { lt: before } },
      take: 100,
    });
    for (const cancellation of cancellations) {
      try {
        await this.executeCancellation(cancellation.id, {
          type: 'SYSTEM',
          reason: 'resume interrupted cancellation',
        });
        summary.cancellations++;
      } catch (err) {
        summary.errors++;
        this.logger.warn(`Resume cancellation ${cancellation.id} failed: ${errorText(err)}`);
      }
    }
    return summary;
  }
}
