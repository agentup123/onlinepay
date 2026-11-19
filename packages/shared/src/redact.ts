/**
 * Defensive redaction for anything that may be logged. Our servers should never receive
 * PAN/CVV, but this guarantees that if one slips into a payload it never reaches logs.
 */
const SENSITIVE_KEYS = new Set([
  'pan',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'cvv2',
  'pin',
  'password',
  'otp',
  'code',
  'token',
  'sessiontoken',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'emiratesid',
  'emirates_id',
  'passportnumber',
  'documentnumber',
  'totpsecret',
]);

// 13–19 digit sequences, optionally separated by spaces or dashes (PAN-like).
const PAN_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;
// Emirates ID: 784-YYYY-NNNNNNN-N
const EID_PATTERN = /\b784-?\d{4}-?\d{7}-?\d\b/g;

export function redactString(value: string): string {
  return value.replace(EID_PATTERN, '[REDACTED_EID]').replace(PAN_PATTERN, '[REDACTED_PAN]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
