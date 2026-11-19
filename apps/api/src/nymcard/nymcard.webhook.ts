import { hmacSha256, safeEqualHex } from '../common/crypto';
import type { NymCardEvent } from './nymcard.types';

/**
 * Verifies a NymCard webhook signature.
 * TODO(nymcard-docs): confirm the signature header, algorithm and whether a timestamp is
 * included in the signed payload. Assumed: hex HMAC-SHA256 of the raw request body.
 */
export function verifyNymCardSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
) {
  if (!signature) return false;
  const provided = signature.replace(/^sha256=/, '').trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  return safeEqualHex(hmacSha256(secret, rawBody), provided.toLowerCase());
}

type Raw = Record<string, unknown>;
type TxnStage = Extract<NymCardEvent, { kind: 'transaction' }>['stage'];
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;

/**
 * Maps a raw NymCard webhook payload into our normalised event.
 *
 * TODO(nymcard-docs): the field names below follow the shape our mock emits
 * ({ id, type, data: {...} }). Replace with NymCard's real event schema once confirmed —
 * this is the ONLY place that needs to change.
 */
export function parseNymCardEvent(payload: Raw): NymCardEvent {
  const eventId = str(payload.id) ?? '';
  const type = str(payload.type) ?? 'unknown';
  const data = (payload.data ?? {}) as Raw;

  const stageByType: Record<string, TxnStage | undefined> = {
    'transaction.authorization': 'AUTHORIZATION',
    'transaction.settlement': 'SETTLEMENT',
    'transaction.reversal': 'REVERSAL',
    'transaction.refund': 'REFUND',
    'transaction.declined': 'DECLINE',
  };

  const stage = stageByType[type];
  if (stage) {
    return {
      kind: 'transaction',
      eventId,
      stage,
      cardId: str(data.card_id) ?? '',
      transactionId: str(data.transaction_id) ?? '',
      amountFils: num(data.amount) ?? 0,
      originalAmount: num(data.original_amount),
      originalCurrency: str(data.original_currency),
      merchantName: str(data.merchant_name),
      merchantCountry: str(data.merchant_country),
      mcc: str(data.mcc),
      declineReason: str(data.decline_reason),
      availableBalanceFils: num(data.available_balance),
      occurredAt: str(data.occurred_at) ?? new Date().toISOString(),
    };
  }

  if (type === 'card.status_changed') {
    const status = str(data.status);
    if (status === 'ACTIVE' || status === 'FROZEN' || status === 'CANCELLED') {
      return {
        kind: 'card_status',
        eventId,
        cardId: str(data.card_id) ?? '',
        status,
        occurredAt: str(data.occurred_at) ?? new Date().toISOString(),
      };
    }
  }

  return { kind: 'unknown', eventId, type };
}
