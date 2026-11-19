import type { CardStatus } from './card-state';

export interface BundleQuotaInput {
  /** Total cards purchased across all paid bundles. */
  purchasedSlots: number;
  /** Statuses of every card the user has ever created. */
  cardStatuses: CardStatus[];
  /** Business rule: does a cancelled card still consume a slot? */
  cancelledCountsAgainstBundle: boolean;
}

export interface BundleQuota {
  purchased: number;
  used: number;
  remaining: number;
}

export function computeQuota(input: BundleQuotaInput): BundleQuota {
  const used = input.cardStatuses.filter(
    (s) => input.cancelledCountsAgainstBundle || s !== 'CANCELLED',
  ).length;
  return {
    purchased: input.purchasedSlots,
    used,
    remaining: Math.max(0, input.purchasedSlots - used),
  };
}
