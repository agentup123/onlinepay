export const CARD_STATUSES = ['ACTIVE', 'FROZEN', 'CANCELLED'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export type CardAction =
  'FREEZE' | 'UNFREEZE' | 'CANCEL' | 'FUND' | 'SET_LIMIT' | 'REVEAL' | 'RENAME';

/**
 * Allowed card actions per status. CANCELLED is terminal: nothing is allowed afterwards.
 */
const ALLOWED: Record<CardStatus, readonly CardAction[]> = {
  ACTIVE: ['FREEZE', 'CANCEL', 'FUND', 'SET_LIMIT', 'REVEAL', 'RENAME'],
  FROZEN: ['UNFREEZE', 'CANCEL', 'SET_LIMIT', 'RENAME'],
  CANCELLED: [],
};

export function canPerform(status: CardStatus, action: CardAction): boolean {
  return ALLOWED[status].includes(action);
}

export function nextStatus(status: CardStatus, action: CardAction): CardStatus {
  if (!canPerform(status, action)) {
    throw new Error(`Action ${action} not allowed when card is ${status}`);
  }
  switch (action) {
    case 'FREEZE':
      return 'FROZEN';
    case 'UNFREEZE':
      return 'ACTIVE';
    case 'CANCEL':
      return 'CANCELLED';
    default:
      return status;
  }
}
