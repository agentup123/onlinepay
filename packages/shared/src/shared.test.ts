import { describe, expect, it } from 'vitest';
import { addVat } from './vat';
import { parseAedToFils } from './money';
import { canPerform, nextStatus } from './card-state';
import { computeQuota } from './bundle';
import { redact } from './redact';
import { uaePhoneSchema } from './schemas';

describe('VAT', () => {
  it('adds 5% VAT to the 30 AED bundle', () => {
    expect(addVat(3000)).toEqual({ subtotalFils: 3000, vatFils: 150, totalFils: 3150, vatRateBps: 500 });
  });
  it('rounds half up to the nearest fils', () => {
    expect(addVat(10).vatFils).toBe(1); // 0.5 fils -> 1
    expect(addVat(9).vatFils).toBe(0); // 0.45 fils -> 0
  });
  it('rejects non-integer amounts', () => {
    expect(() => addVat(10.5)).toThrow();
  });
});

describe('parseAedToFils', () => {
  it('parses without float error', () => {
    expect(parseAedToFils('0.29')).toBe(29);
    expect(parseAedToFils('30')).toBe(3000);
    expect(parseAedToFils('12.5')).toBe(1250);
  });
  it('rejects bad input', () => {
    expect(() => parseAedToFils('1.234')).toThrow();
    expect(() => parseAedToFils('-1')).toThrow();
  });
});

describe('card state machine', () => {
  it('allows freeze/unfreeze and makes cancel terminal', () => {
    expect(nextStatus('ACTIVE', 'FREEZE')).toBe('FROZEN');
    expect(nextStatus('FROZEN', 'UNFREEZE')).toBe('ACTIVE');
    expect(nextStatus('FROZEN', 'CANCEL')).toBe('CANCELLED');
    expect(canPerform('CANCELLED', 'UNFREEZE')).toBe(false);
    expect(() => nextStatus('CANCELLED', 'FREEZE')).toThrow();
  });
  it('blocks funding and reveal on frozen cards', () => {
    expect(canPerform('FROZEN', 'FUND')).toBe(false);
    expect(canPerform('FROZEN', 'REVEAL')).toBe(false);
  });
});

describe('bundle quota', () => {
  const statuses = ['ACTIVE', 'FROZEN', 'CANCELLED', 'CANCELLED'] as const;
  it('counts cancelled cards when the rule says so', () => {
    expect(
      computeQuota({ purchasedSlots: 30, cardStatuses: [...statuses], cancelledCountsAgainstBundle: true }),
    ).toEqual({ purchased: 30, used: 4, remaining: 26 });
  });
  it('frees the slot of cancelled cards otherwise', () => {
    expect(
      computeQuota({ purchasedSlots: 30, cardStatuses: [...statuses], cancelledCountsAgainstBundle: false }),
    ).toEqual({ purchased: 30, used: 2, remaining: 28 });
  });
  it('never goes negative', () => {
    expect(
      computeQuota({ purchasedSlots: 1, cardStatuses: ['ACTIVE', 'ACTIVE'], cancelledCountsAgainstBundle: true })
        .remaining,
    ).toBe(0);
  });
});

describe('redaction', () => {
  it('removes PANs, Emirates IDs and sensitive keys', () => {
    const out = redact({
      note: 'card 4111 1111 1111 1111 eid 784-1990-1234567-1',
      cvv: '123',
      nested: { otp: '123456', ok: 'fine' },
    }) as Record<string, unknown>;
    expect(out.note).toBe('card [REDACTED_PAN] eid [REDACTED_EID]');
    expect(out.cvv).toBe('[REDACTED]');
    expect(out.nested).toEqual({ otp: '[REDACTED]', ok: 'fine' });
  });
});

describe('UAE phone', () => {
  it('normalises local format', () => {
    expect(uaePhoneSchema.parse('050 123 4567')).toBe('+971501234567');
  });
  it('rejects non-UAE numbers', () => {
    expect(uaePhoneSchema.safeParse('+447700900000').success).toBe(false);
  });
});
