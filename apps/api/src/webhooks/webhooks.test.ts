import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@onlinepay/db';
import { hmacSha256 } from '../common/crypto';
import { parseNymCardEvent, verifyNymCardSignature } from '../nymcard/nymcard.webhook';
import { evaluateRules } from '../monitoring/monitoring.rules';
import { WebhooksService } from './webhooks.service';

describe('NymCard webhook signature', () => {
  const secret = 'test-secret-123';
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'transaction.authorization' }));

  it('accepts a valid HMAC', () => {
    expect(verifyNymCardSignature(body, hmacSha256(secret, body), secret)).toBe(true);
    expect(verifyNymCardSignature(body, `sha256=${hmacSha256(secret, body)}`, secret)).toBe(true);
  });
  it('rejects tampered bodies, wrong secrets and missing headers', () => {
    const sig = hmacSha256(secret, body);
    expect(verifyNymCardSignature(Buffer.from('{}'), sig, secret)).toBe(false);
    expect(verifyNymCardSignature(body, sig, 'other-secret')).toBe(false);
    expect(verifyNymCardSignature(body, undefined, secret)).toBe(false);
    expect(verifyNymCardSignature(body, 'not-hex', secret)).toBe(false);
  });
});

describe('parseNymCardEvent', () => {
  it('normalises transaction events', () => {
    const e = parseNymCardEvent({
      id: 'evt_1',
      type: 'transaction.settlement',
      data: {
        card_id: 'c1',
        transaction_id: 't1',
        amount: 3999,
        merchant_name: 'NETFLIX',
        mcc: '4899',
      },
    });
    expect(e).toMatchObject({
      kind: 'transaction',
      stage: 'SETTLEMENT',
      cardId: 'c1',
      transactionId: 't1',
      amountFils: 3999,
    });
  });
  it('normalises card status events and flags unknown types', () => {
    expect(
      parseNymCardEvent({
        id: 'e',
        type: 'card.status_changed',
        data: { card_id: 'c1', status: 'FROZEN' },
      }),
    ).toMatchObject({ kind: 'card_status', status: 'FROZEN' });
    expect(parseNymCardEvent({ id: 'e', type: 'something.else' })).toEqual({
      kind: 'unknown',
      eventId: 'e',
      type: 'something.else',
    });
  });
});

describe('WebhooksService idempotency', () => {
  function setup(createImpl: () => Promise<unknown>) {
    const prisma = { webhookEvent: { create: vi.fn(createImpl) } };
    const queue = { add: vi.fn(async () => undefined) };
    const queues = { nymcardEvents: queue, paymentEvents: queue };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new WebhooksService(prisma as any, queues as any);
    return { service, queue };
  }

  it('stores and enqueues a new event once', async () => {
    const { service, queue } = setup(async () => ({ id: 'row-1' }));
    const res = await service.ingest(
      'nymcard',
      'evt_1',
      'transaction.authorization',
      Buffer.from('{}'),
      {},
    );
    expect(res).toEqual({ duplicate: false, id: 'row-1' });
    expect(queue.add).toHaveBeenCalledWith(
      'transaction.authorization',
      { webhookEventId: 'row-1' },
      expect.objectContaining({ jobId: 'row-1' }),
    );
  });

  it('acknowledges duplicates without enqueuing again', async () => {
    const dup = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, queue } = setup(async () => {
      throw dup;
    });
    const res = await service.ingest(
      'nymcard',
      'evt_1',
      'transaction.authorization',
      Buffer.from('{}'),
      {},
    );
    expect(res).toEqual({ duplicate: true });
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('monitoring rules', () => {
  const cfg = { highAmountFils: 500000, velocityCount: 5, declineCount: 3, riskyMccs: ['7995'] };
  it('flags high amounts, velocity, declines and risky MCCs', () => {
    const hits = evaluateRules(
      {
        amountFils: 600000,
        mcc: '7995',
        stage: 'AUTHORIZATION',
        authsLast10Min: 6,
        declinesLastHour: 0,
      },
      cfg,
    );
    expect(hits.map((h) => h.rule).sort()).toEqual(['HIGH_AMOUNT', 'RISKY_MCC', 'VELOCITY']);
    expect(
      evaluateRules(
        { amountFils: 100, stage: 'DECLINE', authsLast10Min: 0, declinesLastHour: 3 },
        cfg,
      ).map((h) => h.rule),
    ).toEqual(['DECLINES']);
  });
  it('stays quiet for normal activity', () => {
    expect(
      evaluateRules(
        {
          amountFils: 3999,
          mcc: '4899',
          stage: 'AUTHORIZATION',
          authsLast10Min: 1,
          declinesLastHour: 0,
        },
        cfg,
      ),
    ).toEqual([]);
  });
});
