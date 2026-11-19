/**
 * Twilio Programmable Messaging adapter for OTP SMS.
 *
 * UAE rules: promotional and OTP traffic must use a sender ID registered with the TDRA (via
 * Twilio's UAE sender-ID registration). Configure either TWILIO_SENDER_ID (the registered
 * alphanumeric sender, e.g. "OnlinePay") or TWILIO_MESSAGING_SERVICE_SID.
 *
 * The message body contains the OTP, so it is never logged; failures log the HTTP status and
 * Twilio's numeric error code only.
 */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  senderId?: string;
  messagingServiceSid?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class SmsDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerCode?: number,
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

export class TwilioSmsSender {
  constructor(
    private readonly cfg: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!cfg.accountSid || !cfg.authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    }
    if (!cfg.senderId && !cfg.messagingServiceSid) {
      throw new Error('Set TWILIO_SENDER_ID or TWILIO_MESSAGING_SERVICE_SID');
    }
  }

  /** Sends one SMS. Resolves with Twilio's message SID. */
  async send(to: string, body: string): Promise<string> {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.cfg.messagingServiceSid) form.set('MessagingServiceSid', this.cfg.messagingServiceSid);
    else form.set('From', this.cfg.senderId!);

    const base = this.cfg.baseUrl ?? 'https://api.twilio.com';
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 10_000);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; code?: number };
      if (!res.ok || !data.sid) {
        throw new SmsDeliveryError(
          `Twilio rejected SMS (HTTP ${res.status}${data.code ? `, code ${data.code}` : ''})`,
          res.status,
          data.code,
        );
      }
      return data.sid;
    } catch (err) {
      if (err instanceof SmsDeliveryError) throw err;
      throw new SmsDeliveryError(`Twilio request failed: ${(err as Error).name}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
