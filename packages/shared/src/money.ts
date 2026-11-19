/**
 * Money is ALWAYS an integer number of minor units (fils for AED; 100 fils = 1 AED).
 * Never use floating point for amounts.
 */
export type CurrencyCode = 'AED';

export interface Money {
  amountFils: number;
  currency: CurrencyCode;
}

export function assertFils(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of fils, got ${value}`);
  }
}

export function aed(amountAed: number): Money {
  // Accepts human input like 30 or 30.5 and converts once, rounding half away from zero.
  const fils = Math.sign(amountAed) * Math.round(Math.abs(amountAed) * 100);
  return { amountFils: fils, currency: 'AED' };
}

/** Parses a user-entered decimal string ("12.50") into fils without float arithmetic. */
export function parseAedToFils(input: string): number {
  const trimmed = input.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('Invalid AED amount');
  }
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatFils(amountFils: number, locale: 'en' | 'ar' = 'en'): string {
  assertFils(amountFils);
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-AE' : 'en-AE', {
    style: 'currency',
    currency: 'AED',
    minimumFractionDigits: 2,
  }).format(amountFils / 100);
}
