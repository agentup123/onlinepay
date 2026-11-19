/**
 * Provider-agnostic contract for everything OnlinePay needs from the card issuer.
 * Implementations: NymCardMockClient (dev/test) and NymCardHttpClient (sandbox/production).
 * Amounts are integer fils (AED minor units).
 */
export const NYMCARD_CLIENT = Symbol('NYMCARD_CLIENT');

export type IssuerCardStatus = 'ACTIVE' | 'FROZEN' | 'CANCELLED';

export interface IssuerCard {
  id: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  status: IssuerCardStatus;
  balanceFils: number;
}

export interface CreateCardholderInput {
  externalRef: string; // our user id
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality: string; // ISO-3166 alpha-2
}

export interface FundsResult {
  providerRef: string;
  balanceFils: number;
}

export interface SecureDisplaySession {
  /** URL for an iframe hosted by the issuer that renders PAN/CVV. Never proxied by us. */
  url: string;
  expiresAt: Date;
}

export interface IssuerTransaction {
  id: string;
  cardId: string;
  type: 'AUTHORIZATION' | 'SETTLEMENT' | 'REVERSAL' | 'REFUND' | 'DECLINE';
  amountFils: number;
  merchantName?: string;
  mcc?: string;
  occurredAt: Date;
}

export interface NymCardClient {
  createCardholder(input: CreateCardholderInput): Promise<{ cardholderId: string }>;
  createVirtualCard(input: {
    cardholderId: string;
    label: string;
    idempotencyKey: string;
  }): Promise<IssuerCard>;
  getCard(cardId: string): Promise<IssuerCard>;
  setCardStatus(cardId: string, status: IssuerCardStatus, reason?: string): Promise<void>;
  setSpendingLimit(cardId: string, limitFils: number | null): Promise<void>;
  loadFunds(cardId: string, amountFils: number, idempotencyKey: string): Promise<FundsResult>;
  unloadFunds(cardId: string, amountFils: number, idempotencyKey: string): Promise<FundsResult>;
  createSecureDisplaySession(cardId: string): Promise<SecureDisplaySession>;
  listTransactions(cardId: string, since?: Date): Promise<IssuerTransaction[]>;
}

// ── Normalised webhook events (what the rest of the app consumes) ──

export type NymCardEvent =
  | {
      kind: 'transaction';
      eventId: string;
      cardId: string;
      transactionId: string;
      stage: 'AUTHORIZATION' | 'SETTLEMENT' | 'REVERSAL' | 'REFUND' | 'DECLINE';
      amountFils: number;
      originalAmount?: number;
      originalCurrency?: string;
      merchantName?: string;
      merchantCountry?: string;
      mcc?: string;
      declineReason?: string;
      availableBalanceFils?: number;
      occurredAt: string;
    }
  | {
      kind: 'card_status';
      eventId: string;
      cardId: string;
      status: IssuerCardStatus;
      occurredAt: string;
    }
  | { kind: 'unknown'; eventId: string; type: string };
