import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { hmacSha256, safeEqualHex } from '../common/crypto';
import type { CheckoutSessionInput, GatewayEvent, PaymentGateway } from './gateway.types';

export interface CheckoutComConfig {
  baseUrl: string;
  secretKey: string;
  processingChannelId: string;
  webhookSecret: string;
}

/**
 * Checkout.com Hosted Payments Page adapter (supports cards, Apple Pay and Google Pay for UAE
 * merchants once enabled on the account).
 * VERIFY against Checkout.com docs before go-live: endpoint paths, webhook event names and the
 * `Cko-Signature` scheme (HMAC-SHA256 of the raw body using the webhook secret).
 */
export class CheckoutComGateway implements PaymentGateway {
  readonly name = 'checkoutcom';
  private readonly logger = new Logger('CheckoutComGateway');

  constructor(private readonly cfg: CheckoutComConfig) {
    if (!cfg.secretKey || !cfg.processingChannelId || !cfg.webhookSecret) {
      throw new Error('Checkout.com credentials missing (CHECKOUTCOM_* env vars)');
    }
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const res = await fetch(new URL(path, this.cfg.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.secretKey}`,
        'content-type': 'application/json',
        'cko-idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.logger.warn(`Checkout.com POST ${path} -> ${res.status}`);
      throw new ServiceUnavailableException({ code: 'PAYMENT_GATEWAY_ERROR' });
    }
    return (await res.json()) as T;
  }

  async createCheckoutSession(input: CheckoutSessionInput) {
    const res = await this.post<{ id: string; _links: { redirect: { href: string } } }>(
      '/hosted-payments',
      {
        amount: input.amountFils, // AED minor units
        currency: input.currency,
        reference: input.purchaseId,
        description: input.description,
        processing_channel_id: this.cfg.processingChannelId,
        customer: { email: input.customerEmail },
        billing: { address: { country: 'AE' } },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        failure_url: input.failureUrl,
        '3ds': { enabled: true },
      },
      input.idempotencyKey,
    );
    return { sessionId: res.id, redirectUrl: res._links.redirect.href };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = headers['cko-signature'];
    if (typeof sig !== 'string') return false;
    return safeEqualHex(hmacSha256(this.cfg.webhookSecret, rawBody), sig);
  }

  parseWebhook(body: Record<string, unknown>): GatewayEvent {
    const eventId = String(body.id ?? '');
    const type = String(body.type ?? '');
    const data = (body.data ?? {}) as Record<string, unknown>;
    const paymentId = String(data.id ?? '');
    const reference = typeof data.reference === 'string' ? data.reference : undefined;
    switch (type) {
      case 'payment_captured':
        return { eventId, type: 'payment.captured', paymentId, reference, amountFils: Number(data.amount ?? 0) };
      case 'payment_declined':
      case 'payment_capture_declined':
      case 'payment_expired':
        return { eventId, type: 'payment.failed', paymentId, reference };
      case 'payment_refunded':
        return { eventId, type: 'refund.succeeded', paymentId, refundId: String(data.action_id ?? eventId), amountFils: Number(data.amount ?? 0) };
      case 'payment_refund_declined':
        return { eventId, type: 'refund.failed', paymentId, refundId: String(data.action_id ?? eventId) };
      default:
        return { eventId, type: 'ignored' };
    }
  }

  async refund(input: { paymentId: string; amountFils: number; reason: string; idempotencyKey: string }) {
    const res = await this.post<{ action_id: string }>(
      `/payments/${input.paymentId}/refunds`,
      { amount: input.amountFils, reference: input.reason.slice(0, 50) },
      input.idempotencyKey,
    );
    return { refundId: res.action_id };
  }
}
