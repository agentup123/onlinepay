import type { CardStatus } from './card-state';

export interface BundleQuotaInput {
  /** Total cards purchased across all paid bundles. */
  purchasedSlots: number;
  /** Statuses of every card the user has ever created. */
  cardStatuses: CardStatus[];
  /** Business rule: does a cancelled card still consume a slot? */
  cancelledCountsAgainstBundle: boolean;
  /** Card issuances started but not finished yet (they hold a slot until they fail). */
  pendingIssuances?: number;
}

export interface BundleQuota {
  purchased: number;
  used: number;
  remaining: number;
}

export function computeQuota(input: BundleQuotaInput): BundleQuota {
  const used =
    input.cardStatuses.filter((s) => input.cancelledCountsAgainstBundle || s !== 'CANCELLED')
      .length + (input.pendingIssuances ?? 0);
  return {
    purchased: input.purchasedSlots,
    used,
    remaining: Math.max(0, input.purchasedSlots - used),
  };
}
