export type CardStatus = 'ACTIVE' | 'FROZEN' | 'CANCELLED';

export interface Card {
  id: string;
  label: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  status: CardStatus;
  spendingLimitFils: number | null;
  availableBalanceFils: number;
  createdAt: string;
  cancelledAt: string | null;
}

export interface Quota {
  purchased: number;
  used: number;
  remaining: number;
}

export interface CardTransaction {
  id: string;
  type: string;
  status: 'PENDING' | 'SETTLED' | 'REVERSED' | 'DECLINED';
  amountFils: number;
  merchantName: string | null;
  declineReason: string | null;
  occurredAt: string;
}

export interface Wallet {
  balanceFils: number;
  entries: { id: string; type: string; amountFils: number; balanceAfter: number; memo: string | null; createdAt: string }[];
}

export interface Invoice {
  id: string;
  number: string;
  description: string;
  sellerTrn: string;
  subtotalFils: number;
  vatRateBps: number;
  vatFils: number;
  totalFils: number;
  issuedAt: string;
  user?: { fullName: string; email: string };
}

export interface Notification {
  id: string;
  type: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  readAt: string | null;
  createdAt: string;
}
