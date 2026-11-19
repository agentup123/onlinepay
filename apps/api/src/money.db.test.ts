/**
 * Integration tests for every path that moves money, against a real Postgres (advisory locks,
 * transactions and unique constraints are the point, so they can't be mocked).
 *
 * Runs in CI, where migrations are deployed first. Locally: start `pnpm infra:up`, run
 * `pnpm db:deploy`, then `RUN_DB_TESTS=1 pnpm --filter @onlinepay/api test`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './common/audit.service';
import { WalletService } from './wallet/wallet.service';
import { CardsService } from './cards/cards.service';
import { PaymentsService } from './payments/payments.service';
import { InvoiceService } from './payments/invoice.service';
import {
  IssuerRejectedError,
  IssuerUnavailableError,
  type FundsResult,
  type IssuerCard,
  type IssuerCardStatus,
  type NymCardClient,
} from './nymcard/nymcard.types';
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  type PaymentGateway,
} from './payments/gateway.types';

const RUN = process.env.RUN_DB_TESTS === '1';
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };

/** What the next issuer call does. "timeout-after" = applied at the issuer, response lost. */
type Mode = 'ok' | 'reject' | 'timeout-before' | 'timeout-after';

/**
 * In-memory issuer with real-issuer idempotency semantics: the outcome of a request (success or
 * rejection) is remembered per idempotency key and replayed on retry.
 */
class FakeIssuer implements NymCardClient {
  cards = new Map<string, IssuerCard>();
  outcomes = new Map<string, FundsResult | { rejected: string } | IssuerCard>();
  /** Every load/unload actually applied, by reference — what findFundsOperation searches. */
  applied = new Map<string, FundsResult>();
  /** false = a misbehaving issuer that re-executes repeated idempotency keys. */
  idempotent = true;
  next: Mode[] = [];

  private mode(): Mode {
    return this.next.shift() ?? 'ok';
  }

  async createCardholder() {
    return { cardholderId: `holder-${randomUUID()}` };
  }

  async createVirtualCard(input: { idempotencyKey: string }) {
    const prior = this.outcomes.get(input.idempotencyKey);
    if (prior) return prior as IssuerCard;
    const mode = this.mode();
    if (mode === 'reject') throw new IssuerRejectedError('rejected', 422);
    if (mode === 'timeout-before') throw new IssuerUnavailableError('timeout');
    const card: IssuerCard = {
      id: `fake-${randomUUID()}`,
      last4: '4242',
      expiryMonth: 12,
      expiryYear: 2030,
      status: 'ACTIVE',
      balanceFils: 0,
    };
    this.cards.set(card.id, card);
    this.outcomes.set(input.idempotencyKey, card);
    if (mode === 'timeout-after') throw new IssuerUnavailableError('timeout');
    return card;
  }

  async getCard(id: string) {
    const card = this.cards.get(id);
    if (!card) throw new IssuerRejectedError('not found', 404);
    return { ...card };
  }

  async setCardStatus(id: string, status: IssuerCardStatus) {
    const card = this.cards.get(id)!;
    if (card.status === 'CANCELLED') throw new IssuerRejectedError('cancelled', 422);
    card.status = status;
  }

  async setSpendingLimit() {}

  async loadFunds(id: string, amount: number, key: string) {
    return this.adjust(id, amount, key);
  }

  async unloadFunds(id: string, amount: number, key: string) {
    return this.adjust(id, -amount, key);
  }

  async findFundsOperation(_id: string, reference: string) {
    return this.applied.get(reference) ?? null;
  }

  private async adjust(id: string, delta: number, key: string): Promise<FundsResult> {
    const prior = this.idempotent ? this.outcomes.get(key) : undefined;
    if (prior && 'rejected' in prior) throw new IssuerRejectedError(prior.rejected, 422);
    if (prior) return prior as FundsResult;
    const mode = this.mode();
    const card = this.cards.get(id)!;
    if (mode === 'reject' || (delta > 0 && card.status !== 'ACTIVE')) {
      this.outcomes.set(key, { rejected: 'rejected' });
      throw new IssuerRejectedError('rejected', 422);
    }
    if (mode === 'timeout-before') throw new IssuerUnavailableError('timeout');
    card.balanceFils += delta;
    const result = { providerRef: `ref-${randomUUID()}`, balanceFils: card.balanceFils };
    this.outcomes.set(key, result);
    this.applied.set(key, result);
    if (mode === 'timeout-after') throw new IssuerUnavailableError('timeout');
    return result;
  }

  async createSecureDisplaySession() {
    return { url: 'https://example.invalid', expiresAt: new Date() };
  }

  async listTransactions() {
    return [];
  }
}

class FakeGateway implements PaymentGateway {
  readonly name = 'fake';
  refunds = new Map<string, string>();
  next: Mode[] = [];
  async createCheckoutSession() {
    return { sessionId: `sess-${randomUUID()}`, redirectUrl: 'https://example.invalid' };
  }
  verifyWebhook() {
    return true;
  }
  parseWebhook() {
    return { eventId: 'x', type: 'ignored' as const };
  }
  async refund(input: { idempotencyKey: string }) {
    const prior = this.refunds.get(input.idempotencyKey);
    if (prior) return { refundId: prior };
    const mode = this.next.shift() ?? 'ok';
    if (mode === 'reject') throw new GatewayRejectedError('declined');
    if (mode === 'timeout-before') throw new GatewayUnavailableError('timeout');
    const refundId = `rf-${randomUUID()}`;
    this.refunds.set(input.idempotencyKey, refundId);
    if (mode === 'timeout-after') throw new GatewayUnavailableError('timeout');
    return { refundId };
  }
}

describe.skipIf(!RUN)('money paths (Postgres)', () => {
  let prisma: PrismaService;
  let issuer: FakeIssuer;
  let gateway: FakeGateway;
  let wallet: WalletService;
  let cards: CardsService;
  let payments: PaymentsService;

  const notifications = { notify: async () => undefined };
  const kyc = {
    assertApproved: async () => undefined,
    ensureCardholder: async () => 'holder-test',
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    issuer = new FakeIssuer();
    gateway = new FakeGateway();
    const audit = new AuditService(prisma);
    wallet = new WalletService(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyNotifications = notifications as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyKyc = kyc as any;
    cards = new CardsService(prisma, audit, anyNotifications, anyKyc, wallet, issuer);
    payments = new PaymentsService(
      prisma,
      audit,
      anyNotifications,
      anyKyc,
      wallet,
      new InvoiceService(),
      gateway,
    );
  });

  async function newUser(walletFils = 0) {
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        fullName: 'Test User',
        email: `t-${tag}@example.test`,
        phone: `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        status: 'ACTIVE',
        termsAcceptedAt: new Date(),
        nymcardHolderId: `holder-${tag}`,
      },
    });
    if (walletFils > 0) {
      await wallet.credit({
        userId: user.id,
        amountFils: walletFils,
        type: 'ADJUSTMENT',
        idempotencyKey: `seed:${user.id}`,
      });
    }
    return user;
  }

  async function newCard(userId: string) {
    const remote = await issuer.createVirtualCard({ idempotencyKey: randomUUID() });
    return prisma.card.create({
      data: {
        userId,
        nymcardCardId: remote.id,
        label: 'Test',
        last4: '4242',
        expiryMonth: 12,
        expiryYear: 2030,
      },
    });
  }

  const balance = async (userId: string) =>
    (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).balanceFils;

  // ── C1 ──
  it('a rejected funding cannot be retried into a free (or larger) card load', async () => {
    const user = await newUser(10_000);
    const card = await newCard(user.id);
    issuer.next = ['reject'];
    await expect(cards.fund(user.id, card.id, 100, 'key-A', meta)).rejects.toBeInstanceOf(
      IssuerRejectedError,
    );
    expect(await balance(user.id)).toBe(10_000); // debited then refunded

    // Same key, bigger amount: refused outright.
    await expect(cards.fund(user.id, card.id, 5_000, 'key-A', meta)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    // Same key, same amount: the failure is final.
    await expect(cards.fund(user.id, card.id, 100, 'key-A', meta)).rejects.toMatchObject({
      response: { code: 'CARD_FUNDING_FAILED' },
    });
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(0);
    expect(await balance(user.id)).toBe(10_000);
  });

  // ── C2 ──
  it('an issuer timeout after the load never refunds the wallet; resume settles it', async () => {
    const user = await newUser(10_000);
    const card = await newCard(user.id);
    issuer.next = ['timeout-after'];
    await expect(cards.fund(user.id, card.id, 2_500, 'key-B', meta)).rejects.toMatchObject({
      response: { code: 'CARD_FUNDING_PENDING' },
    });
    expect(await balance(user.id)).toBe(7_500);
    const funding = await prisma.cardFunding.findFirstOrThrow({ where: { cardId: card.id } });
    expect(funding.status).toBe('UNKNOWN');

    await cards.executeFunding(funding.id);
    expect((await prisma.cardFunding.findUniqueOrThrow({ where: { id: funding.id } })).status).toBe(
      'SUCCEEDED',
    );
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(2_500);
    expect(await balance(user.id)).toBe(7_500);
  });

  it('even an issuer that ignores idempotency keys is never loaded twice', async () => {
    const user = await newUser(10_000);
    const card = await newCard(user.id);
    issuer.idempotent = false;
    issuer.next = ['timeout-after'];
    await expect(cards.fund(user.id, card.id, 2_000, 'key-B2', meta)).rejects.toMatchObject({
      response: { code: 'CARD_FUNDING_PENDING' },
    });
    // Resume (client retry and worker) looks the load up by reference instead of resending it.
    await cards.fund(user.id, card.id, 2_000, 'key-B2', meta);
    const funding = await prisma.cardFunding.findFirstOrThrow({ where: { cardId: card.id } });
    await cards.executeFunding(funding.id);
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(2_000);
    expect(await balance(user.id)).toBe(8_000);
  });

  it('a failed lookup leaves the funding pending instead of resending', async () => {
    const user = await newUser(10_000);
    const card = await newCard(user.id);
    issuer.next = ['timeout-before'];
    await expect(cards.fund(user.id, card.id, 1_000, 'key-B3', meta)).rejects.toBeTruthy();
    const lookup = issuer.findFundsOperation.bind(issuer);
    issuer.findFundsOperation = async () => {
      throw new IssuerUnavailableError('lookup down');
    };
    await expect(cards.fund(user.id, card.id, 1_000, 'key-B3', meta)).rejects.toMatchObject({
      response: { code: 'CARD_FUNDING_PENDING' },
    });
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(0);
    issuer.findFundsOperation = lookup;
    await expect(cards.fund(user.id, card.id, 1_000, 'key-B3', meta)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(1_000);
    expect(await balance(user.id)).toBe(9_000);
  });

  it('a client retry after a timeout before the load loads exactly once', async () => {
    const user = await newUser(10_000);
    const card = await newCard(user.id);
    issuer.next = ['timeout-before'];
    await expect(cards.fund(user.id, card.id, 1_000, 'key-C', meta)).rejects.toBeTruthy();
    await expect(cards.fund(user.id, card.id, 1_000, 'key-C', meta)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    await expect(cards.fund(user.id, card.id, 1_000, 'key-C', meta)).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(1_000);
    expect(await balance(user.id)).toBe(9_000);
  });

  it('concurrent fundings can never overdraw the wallet', async () => {
    const user = await newUser(1_000);
    const card = await newCard(user.id);
    const results = await Promise.allSettled([
      cards.fund(user.id, card.id, 700, 'key-D1', meta),
      cards.fund(user.id, card.id, 700, 'key-D2', meta),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(user.id)).toBe(300);
    expect((await issuer.getCard(card.nymcardCardId)).balanceFils).toBe(700);
  });

  it('a ledger replay must match the original movement', async () => {
    const user = await newUser(1_000);
    await wallet.debit({
      userId: user.id,
      amountFils: 100,
      type: 'CARD_FUND',
      idempotencyKey: `x:${user.id}`,
    });
    await expect(
      wallet.debit({
        userId: user.id,
        amountFils: 900,
        type: 'CARD_FUND',
        idempotencyKey: `x:${user.id}`,
      }),
    ).rejects.toMatchObject({ response: { code: 'LEDGER_IDEMPOTENCY_MISMATCH' } });
    expect(await balance(user.id)).toBe(900);
  });

  // ── I1 ──
  it('cancel resumes after the unload response was lost and credits the balance once', async () => {
    const user = await newUser(5_000);
    const card = await newCard(user.id);
    await cards.fund(user.id, card.id, 3_000, 'key-E', meta);
    expect(await balance(user.id)).toBe(2_000);

    issuer.next = ['timeout-after']; // the unload happens, our process never hears back
    await expect(
      cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta),
    ).rejects.toBeInstanceOf(IssuerUnavailableError);
    const pending = await prisma.cardCancellation.findUniqueOrThrow({ where: { cardId: card.id } });
    expect(pending).toMatchObject({ status: 'SWEEPING', sweepFils: 3_000 });

    const done = await cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta);
    expect(done).toMatchObject({ returnedFils: 3_000, card: { status: 'CANCELLED' } });
    expect(await balance(user.id)).toBe(5_000);
    // Retrying again changes nothing.
    await cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta);
    expect(await balance(user.id)).toBe(5_000);
    expect((await issuer.getCard(card.nymcardCardId)).status).toBe('CANCELLED');
  });

  it('cancel waits for an in-flight funding, and funding is refused while cancelling', async () => {
    const user = await newUser(5_000);
    const card = await newCard(user.id);
    issuer.next = ['timeout-before'];
    await expect(cards.fund(user.id, card.id, 1_000, 'key-F', meta)).rejects.toBeTruthy();
    await expect(
      cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta),
    ).rejects.toMatchObject({ response: { code: 'CARD_OPERATION_IN_PROGRESS' } });

    const funding = await prisma.cardFunding.findFirstOrThrow({ where: { cardId: card.id } });
    await cards.executeFunding(funding.id);
    await cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta);
    await expect(cards.fund(user.id, card.id, 500, 'key-F2', meta)).rejects.toMatchObject({
      response: { code: 'CARD_ACTION_NOT_ALLOWED' },
    });
    expect(await balance(user.id)).toBe(5_000);
  });

  // ── I2 / I3 ──
  it('a user can neither unfreeze nor cancel a card frozen by compliance', async () => {
    const user = await newUser();
    const card = await newCard(user.id);
    const admin = { type: 'ADMIN' as const, id: randomUUID(), reason: 'AML review' };
    await cards.setFrozen(admin, user.id, card.id, true, meta);
    await expect(
      cards.setFrozen({ type: 'USER', id: user.id }, user.id, card.id, false, meta),
    ).rejects.toMatchObject({ response: { code: 'CARD_FROZEN_BY_ADMIN' } });
    await expect(
      cards.cancel({ type: 'USER', id: user.id }, user.id, card.id, meta),
    ).rejects.toMatchObject({ response: { code: 'CARD_FROZEN_BY_ADMIN' } });
    // An admin freeze on a user-frozen card escalates it.
    const other = await newCard(user.id);
    await cards.setFrozen({ type: 'USER', id: user.id }, user.id, other.id, true, meta);
    await cards.setFrozen(admin, user.id, other.id, true, meta);
    await expect(
      cards.setFrozen({ type: 'USER', id: user.id }, user.id, other.id, false, meta),
    ).rejects.toMatchObject({ response: { code: 'CARD_FROZEN_BY_ADMIN' } });
  });

  it('freezeAllForUser freezes every live card at the issuer', async () => {
    const user = await newUser();
    const a = await newCard(user.id);
    const b = await newCard(user.id);
    const res = await cards.freezeAllForUser(
      { type: 'ADMIN', id: randomUUID(), reason: 'suspended' },
      user.id,
      meta,
    );
    expect(res).toEqual({ frozen: 2, failed: [] });
    expect((await issuer.getCard(a.nymcardCardId)).status).toBe('FROZEN');
    expect((await issuer.getCard(b.nymcardCardId)).status).toBe('FROZEN');
  });

  // ── I7 ──
  it('card issuance reserves a slot and survives an issuer timeout', async () => {
    const user = await newUser();
    const bundle = await prisma.bundle.upsert({
      where: { code: 'TEST_2' },
      update: {},
      create: { code: 'TEST_2', nameEn: 'Test 2', nameAr: 'Test 2', cardQuota: 2, priceFils: 200 },
    });
    await prisma.purchase.create({
      data: {
        userId: user.id,
        type: 'BUNDLE',
        bundleId: bundle.id,
        cardQuota: 2,
        subtotalFils: 200,
        vatFils: 10,
        totalFils: 210,
        status: 'PAID',
        gateway: 'fake',
        idempotencyKey: `p:${user.id}`,
      },
    });
    issuer.next = ['timeout-after'];
    await expect(cards.create(user, { label: 'Netflix' }, 'issue-1', meta)).rejects.toBeInstanceOf(
      IssuerUnavailableError,
    );
    expect(await cards.quota(user.id)).toMatchObject({ used: 1, remaining: 1 });

    const card = await cards.create(user, { label: 'Netflix' }, 'issue-1', meta);
    const again = await cards.create(user, { label: 'Netflix' }, 'issue-1', meta);
    expect(again.id).toBe(card.id);
    expect(issuer.cards.size).toBe(1);
    expect(await cards.quota(user.id)).toMatchObject({ used: 1, remaining: 1 });
  });

  // ── I4 ──
  async function paidTopUp(userId: string, totalFils: number) {
    const purchase = await prisma.purchase.create({
      data: {
        userId,
        type: 'WALLET_TOPUP',
        subtotalFils: totalFils,
        vatFils: 0,
        totalFils,
        status: 'PAID',
        gateway: 'fake',
        gatewayPaymentId: `pay-${randomUUID()}`,
        idempotencyKey: `t:${randomUUID()}`,
      },
    });
    await wallet.credit({
      userId,
      amountFils: totalFils,
      type: 'TOPUP',
      idempotencyKey: `topup:${purchase.id}`,
      purchaseId: purchase.id,
    });
    return purchase;
  }

  it('concurrent refunds cannot exceed the payment', async () => {
    const user = await newUser();
    const purchase = await paidTopUp(user.id, 5_000);
    const adminId = randomUUID();
    const results = await Promise.allSettled([
      payments.refund(purchase.id, 5_000, 'customer request', adminId, meta),
      payments.refund(purchase.id, 5_000, 'customer request', adminId, meta),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(gateway.refunds.size).toBe(1);
    expect(await balance(user.id)).toBe(0);
  });

  it('an unknown gateway outcome is retried with the same key; a rejection refunds the wallet', async () => {
    const user = await newUser();
    const purchase = await paidTopUp(user.id, 4_000);
    gateway.next = ['timeout-after'];
    await expect(
      payments.refund(purchase.id, 1_000, 'customer request', randomUUID(), meta),
    ).rejects.toMatchObject({ response: { code: 'REFUND_PENDING' } });
    expect(await balance(user.id)).toBe(3_000);
    const refund = await prisma.refund.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    await payments.submitRefund(refund.id);
    expect(gateway.refunds.size).toBe(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      'PROCESSING',
    );

    gateway.next = ['reject'];
    await expect(
      payments.refund(purchase.id, 1_000, 'customer request', randomUUID(), meta),
    ).rejects.toBeInstanceOf(GatewayRejectedError);
    expect(await balance(user.id)).toBe(3_000); // debited, then returned
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe(
      'PARTIALLY_REFUNDED',
    );
  });
});
