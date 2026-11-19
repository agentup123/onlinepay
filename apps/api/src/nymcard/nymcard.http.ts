import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateCardholderInput,
  FundsResult,
  IssuerCard,
  IssuerCardStatus,
  IssuerTransaction,
  NymCardClient,
  SecureDisplaySession,
} from './nymcard.types';
import { IssuerRejectedError, IssuerUnavailableError, issuerErrorForStatus } from './nymcard.types';

// TODO(nymcard-docs): confirm the full list of NymCard card statuses.
const ISSUER_STATUS_MAP: Record<string, IssuerCardStatus | undefined> = {
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
  BLOCKED: 'FROZEN',
  SUSPENDED: 'FROZEN',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CANCELLED',
  TERMINATED: 'CANCELLED',
};

export interface NymCardHttpConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret?: string;
  productId?: string;
  timeoutMs?: number;
}

/**
 * Real NymCard client. All calls go server-to-server; credentials never reach a browser.
 *
 * IMPORTANT — TODO(nymcard-docs): the endpoint paths, auth scheme and field names below are
 * PLACEHOLDERS to be confirmed against NymCard's sandbox documentation. Each one is listed in
 * docs/NYMCARD_INTEGRATION.md. Nothing here has been verified against the live API.
 */
export class NymCardHttpClient implements NymCardClient {
  private readonly logger = new Logger('NymCardHttpClient');

  constructor(private readonly cfg: NymCardHttpConfig) {
    if (!cfg.baseUrl || !cfg.apiKey) {
      throw new Error(
        'NYMCARD_BASE_URL and NYMCARD_API_KEY are required when NYMCARD_MODE != mock',
      );
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    const requestId = randomUUID();
    let res: Response;
    try {
      res = await fetch(new URL(path, this.cfg.baseUrl), {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // TODO(nymcard-docs): confirm auth (API key header vs OAuth client-credentials token).
          'x-api-key': this.cfg.apiKey,
          'x-request-id': requestId,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Timeout or network failure: the request may still have been applied by NymCard.
      clearTimeout(timer);
      this.logger.warn(
        `NymCard ${method} ${path} failed: ${(err as Error).name} (request ${requestId})`,
      );
      throw new IssuerUnavailableError(`${method} ${path}: ${(err as Error).name}`);
    }
    try {
      if (!res.ok) {
        // Log status + request id only; response bodies may contain card data.
        this.logger.warn(`NymCard ${method} ${path} -> ${res.status} (request ${requestId})`);
        throw issuerErrorForStatus(res.status, `${method} ${path}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof IssuerRejectedError || err instanceof IssuerUnavailableError) throw err;
      // The response body could not be read: treat the outcome as unknown.
      throw new IssuerUnavailableError(`${method} ${path}: unreadable response`);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapCard(raw: Record<string, unknown>): IssuerCard {
    // TODO(nymcard-docs): confirm card response fields.
    const rawStatus = String(raw.status ?? '').toUpperCase();
    const status = ISSUER_STATUS_MAP[rawStatus];
    if (!status) {
      // Never guess: mapping an unknown status to CANCELLED would let reconciliation kill a
      // live card and strand its balance.
      throw new IssuerUnavailableError(`Unrecognised NymCard card status "${rawStatus}"`);
    }
    return {
      id: String(raw.id),
      last4: String(raw.last_four ?? raw.last4 ?? ''),
      expiryMonth: Number(raw.expiry_month),
      expiryYear: Number(raw.expiry_year),
      status,
      balanceFils: Number(raw.available_balance ?? 0),
    };
  }

  async createCardholder(input: CreateCardholderInput) {
    const res = await this.request<{ id: string }>(
      'POST',
      '/v1/cardholders',
      {
        external_ref: input.externalRef,
        name: input.fullName,
        email: input.email,
        mobile: input.phone,
        date_of_birth: input.dateOfBirth,
        nationality: input.nationality,
      },
      `holder-${input.externalRef}`,
    );
    return { cardholderId: res.id };
  }

  async createVirtualCard(input: { cardholderId: string; label: string; idempotencyKey: string }) {
    const res = await this.request<Record<string, unknown>>(
      'POST',
      '/v1/cards',
      {
        cardholder_id: input.cardholderId,
        product_id: this.cfg.productId,
        type: 'VIRTUAL',
        nickname: input.label,
      },
      input.idempotencyKey,
    );
    return this.mapCard(res);
  }

  async getCard(cardId: string) {
    return this.mapCard(await this.request<Record<string, unknown>>('GET', `/v1/cards/${cardId}`));
  }

  async setCardStatus(cardId: string, status: IssuerCardStatus, reason?: string) {
    await this.request('PUT', `/v1/cards/${cardId}/status`, { status, reason });
  }

  async setSpendingLimit(cardId: string, limitFils: number | null) {
    await this.request('PUT', `/v1/cards/${cardId}/limits`, { amount: limitFils, currency: 'AED' });
  }

  async loadFunds(
    cardId: string,
    amountFils: number,
    idempotencyKey: string,
  ): Promise<FundsResult> {
    const res = await this.request<{ id: string; available_balance: number }>(
      'POST',
      `/v1/cards/${cardId}/load`,
      { amount: amountFils, currency: 'AED', reference: idempotencyKey },
      idempotencyKey,
    );
    return { providerRef: res.id, balanceFils: res.available_balance };
  }

  async unloadFunds(
    cardId: string,
    amountFils: number,
    idempotencyKey: string,
  ): Promise<FundsResult> {
    const res = await this.request<{ id: string; available_balance: number }>(
      'POST',
      `/v1/cards/${cardId}/unload`,
      { amount: amountFils, currency: 'AED', reference: idempotencyKey },
      idempotencyKey,
    );
    return { providerRef: res.id, balanceFils: res.available_balance };
  }

  async findFundsOperation(cardId: string, reference: string): Promise<FundsResult | null> {
    // TODO(nymcard-docs): confirm how to look up a load/unload by our reference (filter on the
    // card's transfer history, or a dedicated endpoint) and which statuses mean "applied".
    const res = await this.request<{ data: Record<string, unknown>[] }>(
      'GET',
      `/v1/cards/${cardId}/transfers?reference=${encodeURIComponent(reference)}`,
    );
    const op = res.data.find(
      (t) => t.reference === reference && String(t.status ?? '').toUpperCase() !== 'FAILED',
    );
    if (!op) return null;
    return { providerRef: String(op.id), balanceFils: Number(op.available_balance ?? NaN) };
  }

  async createSecureDisplaySession(cardId: string): Promise<SecureDisplaySession> {
    const res = await this.request<{ url: string; expires_at: string }>(
      'POST',
      `/v1/cards/${cardId}/secure-display`,
    );
    return { url: res.url, expiresAt: new Date(res.expires_at) };
  }

  async listTransactions(cardId: string, since?: Date): Promise<IssuerTransaction[]> {
    const qs = since ? `?from=${encodeURIComponent(since.toISOString())}` : '';
    const res = await this.request<{ data: Record<string, unknown>[] }>(
      'GET',
      `/v1/cards/${cardId}/transactions${qs}`,
    );
    return res.data.map((t) => ({
      id: String(t.id),
      cardId,
      type: String(t.type).toUpperCase() as IssuerTransaction['type'],
      amountFils: Number(t.amount),
      merchantName: t.merchant_name ? String(t.merchant_name) : undefined,
      mcc: t.mcc ? String(t.mcc) : undefined,
      occurredAt: new Date(String(t.created_at)),
    }));
  }
}
