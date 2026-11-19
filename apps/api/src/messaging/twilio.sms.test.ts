import { describe, expect, it, vi } from 'vitest';
import { SmsDeliveryError, TwilioSmsSender } from './twilio.sms';

const cfg = { accountSid: 'AC123', authToken: 'secret', senderId: 'OnlinePay' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe('TwilioSmsSender', () => {
  it('posts a form to the Messages API with basic auth and the registered sender', async () => {
    const f = fakeFetch(201, { sid: 'SM1' });
    await expect(new TwilioSmsSender(cfg, f).send('+971501234567', 'code 123456')).resolves.toBe(
      'SM1',
    );
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
    );
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+971501234567');
    expect(form.get('From')).toBe('OnlinePay');
    expect(form.get('Body')).toBe('code 123456');
  });

  it('prefers a Messaging Service when configured', async () => {
    const f = fakeFetch(201, { sid: 'SM2' });
    await new TwilioSmsSender({ ...cfg, messagingServiceSid: 'MG1' }, f).send('+971501234567', 'x');
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const form = new URLSearchParams(init.body);
    expect(form.get('MessagingServiceSid')).toBe('MG1');
    expect(form.get('From')).toBeNull();
  });

  it('surfaces Twilio errors without the message body', async () => {
    const f = fakeFetch(400, { code: 21211, message: 'Invalid To' });
    const err = await new TwilioSmsSender(cfg, f)
      .send('+971500000000', 'code 999999')
      .catch((e) => e);
    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect(err.providerCode).toBe(21211);
    expect(err.message).not.toContain('999999');
  });

  it('requires credentials and a sender', () => {
    expect(() => new TwilioSmsSender({ ...cfg, authToken: '' })).toThrow();
    expect(() => new TwilioSmsSender({ accountSid: 'AC', authToken: 't' })).toThrow();
  });
});
