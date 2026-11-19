import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import type {
  CreateCardholderInput,
  FundsResult,
  IssuerCard,
  IssuerCardStatus,
  IssuerTransaction,
  NymCardClient,
  SecureDisplaySession,
} from './nymcard.types';
import { IssuerRejectedError } from './nymcard.types';

/**
 * Deterministic NymCard stand-in for development and tests. State lives in Redis so the API
 * and worker processes see the same cards. Never used in production (env.ts enforces this).
 */
export class NymCardMockClient implements NymCardClient {
  constructor(private readonly redis: Redis) {}

  private key(cardId: string) {
    return `mock:nymcard:card:${cardId}`;
  }

  async createCardholder(input: CreateCardholderInput) {
    return { cardholderId: `mock-holder-${input.externalRef}` };
  }

  async createVirtualCard(input: { cardholderId: string; label: string; idempotencyKey: string }) {
    const existingId = await this.redis.get(`mock:nymcard:idem:${input.idempotencyKey}`);
    if (existingId) return this.getCard(existingId);

    const id = `mock-card-${randomUUID()}`;
    const now = new Date();
    const card: IssuerCard = {
      id,
      last4: String(Math.floor(1000 + Math.random() * 9000)),
      expiryMonth: now.getMonth() + 1,
      expiryYear: now.getFullYear() + 3,
      status: 'ACTIVE',
      balanceFils: 0,
    };
    await this.redis.set(this.key(id), JSON.stringify(card));
    await this.redis.set(`mock:nymcard:idem:${input.idempotencyKey}`, id, 'EX', 86400);
    return card;
  }

  async getCard(cardId: string): Promise<IssuerCard> {
    const raw = await this.redis.get(this.key(cardId));
    if (raw) return JSON.parse(raw) as IssuerCard;
    // Seeded cards (mock-card-*) that were never created through the mock: synthesise them.
    if (cardId.startsWith('mock-card-')) {
      const card: IssuerCard = {
        id: cardId,
        last4: '0000',
        expiryMonth: 12,
        expiryYear: 2029,
        status: 'ACTIVE',
        balanceFils: 5000,
      };
      await this.redis.set(this.key(cardId), JSON.stringify(card));
      return card;
    }
    throw new IssuerRejectedError('Mock card not found', 404);
  }

  private async save(card: IssuerCard) {
    await this.redis.set(this.key(card.id), JSON.stringify(card));
  }

  async setCardStatus(cardId: string, status: IssuerCardStatus) {
    const card = await this.getCard(cardId);
    if (card.status === 'CANCELLED') throw new IssuerRejectedError('Card already cancelled', 422);
    card.status = status;
    await this.save(card);
  }

  async setSpendingLimit(cardId: string) {
    await this.getCard(cardId);
  }

  async loadFunds(
    cardId: string,
    amountFils: number,
    idempotencyKey: string,
  ): Promise<FundsResult> {
    return this.adjust(cardId, amountFils, idempotencyKey);
  }

  async unloadFunds(
    cardId: string,
    amountFils: number,
    idempotencyKey: string,
  ): Promise<FundsResult> {
    return this.adjust(cardId, -amountFils, idempotencyKey);
  }

  private async adjust(
    cardId: string,
    delta: number,
    idempotencyKey: string,
  ): Promise<FundsResult> {
    // Like a real issuer, the outcome (success OR rejection) is remembered per idempotency key,
    // so a retry with the same key can never turn an earlier rejection into a success.
    const idemKey = `mock:nymcard:funds:${idempotencyKey}`;
    const seen = await this.redis.get(idemKey);
    if (seen) {
      const prior = JSON.parse(seen) as FundsResult | { rejected: string };
      if ('rejected' in prior) throw new IssuerRejectedError(prior.rejected, 422);
      return prior;
    }
    const card = await this.getCard(cardId);
    const rejection =
      card.status !== 'ACTIVE' && delta > 0
        ? 'Card not active'
        : card.balanceFils + delta < 0
          ? 'Insufficient card balance'
          : null;
    if (rejection) {
      await this.redis.set(idemKey, JSON.stringify({ rejected: rejection }), 'EX', 86400);
      throw new IssuerRejectedError(rejection, 422);
    }
    card.balanceFils += delta;
    await this.save(card);
    const result = { providerRef: `mock-funds-${randomUUID()}`, balanceFils: card.balanceFils };
    await this.redis.set(idemKey, JSON.stringify(result), 'EX', 86400);
    return result;
  }

  async createSecureDisplaySession(cardId: string): Promise<SecureDisplaySession> {
    await this.getCard(cardId);
    // Points at a dev-only page that renders a FAKE card number.
    return {
      url: `${env.WEB_URL}/en/dev/secure-display?card=${encodeURIComponent(cardId)}`,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  async listTransactions(_cardId: string): Promise<IssuerTransaction[]> {
    return [];
  }
}
