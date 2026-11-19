export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface CheckoutSessionInput {
  purchaseId: string;
  amountFils: number;
  currency: 'AED';
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  failureUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSession {
  sessionId: string;
  redirectUrl: string;
}

export type GatewayEvent =
  | { eventId: string; type: 'payment.captured'; sessionId?: string; reference?: string; paymentId: string; amountFils: number }
  | { eventId: string; type: 'payment.failed'; sessionId?: string; reference?: string; paymentId?: string }
  | { eventId: string; type: 'refund.succeeded' | 'refund.failed'; paymentId: string; refundId: string; amountFils?: number }
  | { eventId: string; type: 'ignored' };

/**
 * Hosted-payment-page gateway. Card entry, Apple Pay and Google Pay happen on the gateway's
 * page, which keeps OnlinePay out of PCI-DSS card-data scope (SAQ-A).
 */
export interface PaymentGateway {
  readonly name: string;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(body: Record<string, unknown>): GatewayEvent;
  refund(input: { paymentId: string; amountFils: number; reason: string; idempotencyKey: string }): Promise<{ refundId: string }>;
}
