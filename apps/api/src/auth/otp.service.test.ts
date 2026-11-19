import { describe, expect, it, vi } from 'vitest';
import { hmacSha256 } from '../common/crypto';
import { env } from '../config/env';
import { OtpService } from './otp.service';

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    userId: 'u1',
    purpose: 'LOGIN',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    maxAttempts: 5,
    codeHash: hmacSha256(env.OTP_PEPPER, '123456'),
    ...overrides,
  };
}

function setup(row: ReturnType<typeof challenge>, attemptClaims: number[]) {
  const claims = [...attemptClaims];
  const prisma = {
    otpChallenge: {
      findUnique: vi.fn(async () => row),
      // First updateMany = attempt claim, second = consume.
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) =>
        'consumedAt' in args.data ? { count: 1 } : { count: claims.shift() ?? 1 },
      ),
      update: vi.fn(),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OtpService(prisma as any, {} as any);
  return { service, prisma };
}

describe('OtpService.verify', () => {
  it('accepts the right code and consumes the challenge', async () => {
    const { service } = setup(challenge(), [1]);
    await expect(service.verify('c1', '123456', 'LOGIN')).resolves.toBe('u1');
  });

  it('claims an attempt atomically before comparing the code', async () => {
    const { service, prisma } = setup(challenge(), [1]);
    await expect(service.verify('c1', '000000', 'LOGIN')).rejects.toMatchObject({
      response: { code: 'OTP_INVALID' },
    });
    expect(prisma.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', consumedAt: null, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
  });

  it('rejects once the attempt budget is used up, even for the right code', async () => {
    // Parallel guesses: the DB-side conditional increment matched no row.
    const { service } = setup(challenge({ attempts: 4 }), [0]);
    await expect(service.verify('c1', '123456', 'LOGIN')).rejects.toMatchObject({
      response: { code: 'OTP_TOO_MANY_ATTEMPTS' },
    });
  });

  it('rejects expired, consumed and wrong-purpose challenges', async () => {
    await expect(
      setup(challenge({ expiresAt: new Date(Date.now() - 1) }), []).service.verify(
        'c1',
        '123456',
        'LOGIN',
      ),
    ).rejects.toMatchObject({ response: { code: 'OTP_EXPIRED' } });
    await expect(
      setup(challenge({ consumedAt: new Date() }), []).service.verify('c1', '123456', 'LOGIN'),
    ).rejects.toMatchObject({ response: { code: 'OTP_INVALID' } });
    await expect(
      setup(challenge(), []).service.verify('c1', '123456', 'SIGNUP_EMAIL'),
    ).rejects.toMatchObject({ response: { code: 'OTP_INVALID' } });
  });
});
