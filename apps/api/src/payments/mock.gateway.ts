import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import type { CheckoutSessionInput, GatewayEvent, PaymentGateway } from './gateway.types';

/**
 * Dev/test gateway. The "hosted page" is a dev page in the web app that calls
 * POST /webhooks/payments/mock/complete, which feeds the same event pipeline as a real
 * gateway webhook.
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock';

  async createCheckoutSession(input: CheckoutSessionInput) {
    const sessionId = `mock-sess-${randomUUID()}`;
    const params = new URLSearchParams({
      session: sessionId,
      amount: String(input.amountFils),
      success: input.successUrl,
      cancel: input.cancelUrl,
    });
    return { sessionId, redirectUrl: `${env.WEB_URL}/en/dev/mock-pay?${params.toString()}` };
  }

  verifyWebhook() {
    return env.NODE_ENV !== 'production';
  }

  parseWebhook(body: Record<string, unknown>): GatewayEvent {
    const sessionId = String(body.sessionId ?? '');
    if (body.outcome === 'success') {
      return {
        eventId: `mock-evt-${sessionId}-captured`,
        type: 'payment.captured',
        sessionId,
        paymentId: `mock-pay-${sessionId}`,
        amountFils: Number(body.amountFils ?? 0),
        currency: 'AED',
      };
    }
    return { eventId: `mock-evt-${sessionId}-failed`, type: 'payment.failed', sessionId };
  }

  async refund() {
    return { refundId: `mock-refund-${randomUUID()}` };
  }
}
