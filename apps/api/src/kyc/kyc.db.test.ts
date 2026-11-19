/** KYC + sanctions/PEP screening gate, against a real Postgres (see money.db.test.ts). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { KycService } from './kyc.service';
import { MockKycProvider, MockScreeningProvider, type KycProvider } from './kyc.provider';

const RUN = process.env.RUN_DB_TESTS === '1';
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };
const input = {
  documentType: 'EMIRATES_ID' as const,
  nationality: 'AE',
  dateOfBirth: '1990-05-01',
  providerCaptureRef: 'capture-1',
};

describe.skipIf(!RUN)('KYC screening gate (Postgres)', () => {
  let prisma: PrismaService;
  const notifications = { notify: async () => undefined };
  const nymcard = { createCardholder: async () => ({ cardholderId: `holder-${randomUUID()}` }) };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  function service(provider: KycProvider = new MockKycProvider(true)) {
    return new KycService(
      prisma,
      new AuditService(prisma),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notifications as any,
      provider,
      new MockScreeningProvider(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nymcard as any,
    );
  }

  async function newUser(fullName: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        fullName,
        email: `k-${tag}@example.test`,
        phone: `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        status: 'ACTIVE',
        termsAcceptedAt: new Date(),
      },
    });
  }

  it('approves only after a clear screening, and creates the cardholder', async () => {
    const kyc = service();
    const user = await newUser('Clean Customer');
    await expect(kyc.submit(user.id, input, meta)).resolves.toEqual({ status: 'APPROVED' });
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    expect(app.screeningStatus).toBe('CLEAR');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).nymcardHolderId,
    ).toBeTruthy();
    await expect(kyc.assertApproved(user.id)).resolves.toBeUndefined();
  });

  it('holds a screening hit for compliance; approval needs a written disposition', async () => {
    const kyc = service();
    const user = await newUser('Sanctioned Person');
    await expect(kyc.submit(user.id, input, meta)).resolves.toEqual({ status: 'PENDING' });
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    expect(app.screeningStatus).toBe('POTENTIAL_MATCH');
    expect(
      await prisma.suspiciousActivityFlag.count({
        where: { userId: user.id, rule: 'SCREENING_MATCH' },
      }),
    ).toBe(1);
    await expect(kyc.assertApproved(user.id)).rejects.toMatchObject({
      response: { code: 'KYC_REQUIRED' },
    });

    const adminId = randomUUID();
    await expect(kyc.decide(app.id, 'APPROVED', undefined, adminId, meta)).rejects.toMatchObject({
      response: { code: 'SCREENING_MATCH_NOTE_REQUIRED' },
    });
    await kyc.decide(app.id, 'APPROVED', 'Different date of birth and nationality', adminId, meta);
    await expect(kyc.assertApproved(user.id)).resolves.toBeUndefined();
  });

  it('never approves while screening is unavailable', async () => {
    const kyc = service();
    const user = await newUser('Screenfail Person');
    await expect(kyc.submit(user.id, input, meta)).resolves.toEqual({ status: 'PENDING' });
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    expect(app.screeningStatus).toBe('ERROR');
    await expect(
      kyc.decide(app.id, 'APPROVED', 'looks fine', randomUUID(), meta),
    ).rejects.toMatchObject({ response: { code: 'SCREENING_UNAVAILABLE' } });
  });

  it('applies asynchronous vendor decisions through the same gate', async () => {
    const kyc = service(new MockKycProvider(false));
    const user = await newUser('Webhook Customer');
    await expect(kyc.submit(user.id, input, meta)).resolves.toEqual({ status: 'PENDING' });
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    await expect(
      kyc.applyProviderDecision({
        providerRef: app.providerRef,
        status: 'APPROVED',
        verified: { dateOfBirth: '1985-01-02', nationality: 'in' },
      }),
    ).resolves.toEqual({ status: 'APPROVED' });
    const updated = await prisma.kycApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(updated.nationality).toBe('IN'); // provider-verified data wins
    expect(updated.dateOfBirth.toISOString().slice(0, 10)).toBe('1985-01-02');
    // A replayed webhook can't change a final decision.
    await expect(
      kyc.applyProviderDecision({ providerRef: app.providerRef, status: 'REJECTED' }),
    ).resolves.toEqual({ status: 'APPROVED' });
  });

  it('rejects when the verified date of birth is under 18', async () => {
    const kyc = service(new MockKycProvider(false));
    const user = await newUser('Young Customer');
    await kyc.submit(user.id, input, meta);
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    const minor = new Date();
    minor.setUTCFullYear(minor.getUTCFullYear() - 16);
    await expect(
      kyc.applyProviderDecision({
        providerRef: app.providerRef,
        status: 'APPROVED',
        verified: { dateOfBirth: minor.toISOString().slice(0, 10) },
      }),
    ).resolves.toEqual({ status: 'REJECTED' });
  });

  it('a revoked approval blocks access immediately', async () => {
    const kyc = service();
    const user = await newUser('Revoked Customer');
    await kyc.submit(user.id, input, meta);
    const app = await prisma.kycApplication.findFirstOrThrow({ where: { userId: user.id } });
    await kyc.decide(app.id, 'REJECTED', 'Document found to be forged', randomUUID(), meta);
    await expect(kyc.assertApproved(user.id)).rejects.toMatchObject({
      response: { code: 'KYC_REQUIRED' },
    });
  });
});
