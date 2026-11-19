import { assertFils } from './money';

/** VAT rate expressed in basis points (500 = 5.00%, the UAE standard rate). */
export const UAE_VAT_RATE_BPS = 500;

export interface VatBreakdown {
  subtotalFils: number;
  vatFils: number;
  totalFils: number;
  vatRateBps: number;
}

/**
 * Prices are stored VAT-exclusive. VAT is computed with banker-safe integer math and
 * rounded half-up to the nearest fils, per line.
 */
export function addVat(subtotalFils: number, vatRateBps = UAE_VAT_RATE_BPS): VatBreakdown {
  assertFils(subtotalFils, 'subtotal');
  if (subtotalFils < 0) throw new Error('subtotal must be >= 0');
  const vatFils = Math.floor((subtotalFils * vatRateBps + 5000) / 10000);
  return { subtotalFils, vatFils, totalFils: subtotalFils + vatFils, vatRateBps };
}
