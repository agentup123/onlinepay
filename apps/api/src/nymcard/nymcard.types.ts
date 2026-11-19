/**
 * Provider-agnostic contract for everything OnlinePay needs from the card issuer.
 * Implementations: NymCardMockClient (dev/test) and NymCardHttpClient (sandbox/production).
 * Amounts are integer fils (AED minor units).
 */
import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

export const NYMCARD_CLIENT = Symbol('NYMCARD_CLIENT');

/**
 * The issuer definitively rejected the request (validation error, card not active, insufficient
 * balance, …). Nothing happened at the issuer, so it is safe to compensate (e.g. refund a wallet
 * debit).
 */
export class IssuerRejectedError extends UnprocessableEntityException {
  constructor(
    readonly reason: string,
    readonly httpStatus?: number,
  ) {
    super({ code: 'ISSUER_REJECTED', reason, status: httpStatus });
  }
}

/**
 * The outcome is unknown: timeout, network failure, 5xx, 409/429. The operation may or may not
 * have been applied by the issuer. Never compensate on this error — retry with the same
 * idempotency key or reconcile first.
 */
export class IssuerUnavailableError extends ServiceUnavailableException {
  constructor(
    readonly reason: string,
    readonly httpStatus?: number,
  ) {
    super({ code: 'ISSUER_UNAVAILABLE', status: httpStatus });
  }
}

/** HTTP statuses where the request may have been applied (or will be on retry). */
const AMBIGUOUS_STATUSES = new Set([408, 409, 425, 429]);

export function issuerErrorForStatus(status: number, context: string): Error {
  if (status >= 400 && status < 500 && !AMBIGUOUS_STATUSES.has(status)) {
    return new IssuerRejectedError(`${context} -> ${status}`, status);
  }
  return new IssuerUnavailableError(`${context} -> ${status}`, status);
}

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
  /**
   * Looks up a load/unload we sent earlier, by the reference we attached to it (the same value as
   * its idempotency key). Returns null when the issuer has no record of it — i.e. it was never
   * applied and is safe to send again. Used before retrying an operation whose outcome is
   * unknown, so correctness does not depend on the issuer's idempotency handling alone.
   */
  findFundsOperation(cardId: string, reference: string): Promise<FundsResult | null>;
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
