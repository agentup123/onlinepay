import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SignupStartInput } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { randomToken, sha256 } from '../common/crypto';
import type { RequestMeta } from '../common/request';
import { OtpService } from './otp.service';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Step 1 of sign-up. Creates (or resumes) an unverified account and sends two OTPs:
   * one by email and one by SMS. Both must be verified to activate the account.
   */
  async startSignup(input: SignupStartInput) {
    const matches = await this.prisma.user.findMany({
      where: { OR: [{ email: input.email }, { phone: input.phone }] },
    });
    if (matches.some((u) => u.status !== 'PENDING_VERIFICATION')) {
      throw new ConflictException({ code: 'ACCOUNT_EXISTS' });
    }

    // Unverified sign-ups own nothing until both OTPs are verified. If someone started a sign-up
    // with this email or phone but a different counterpart (e.g. a squatter pairing the victim's
    // email with their own phone), release it rather than locking the real owner out. The row is
    // closed (not deleted) so its OTP history still counts towards per-destination rate limits.
    const exact = matches.find((u) => u.email === input.email && u.phone === input.phone);
    for (const stale of matches.filter((u) => u !== exact)) {
      await this.prisma.$transaction([
        this.prisma.user.updateMany({
          where: { id: stale.id, status: 'PENDING_VERIFICATION' },
          data: {
            status: 'CLOSED',
            email: `released+${stale.id}@invalid.onlinepay`,
            phone: `released:${stale.id}`,
          },
        }),
        this.prisma.otpChallenge.updateMany({
          where: { userId: stale.id, consumedAt: null },
          data: { consumedAt: new Date() },
        }),
      ]);
    }

    const user = exact
      ? await this.prisma.user.update({
          where: { id: exact.id },
          data: { fullName: input.fullName, locale: input.locale, termsAcceptedAt: new Date() },
        })
      : await this.prisma.user.create({
          data: {
            fullName: input.fullName,
            email: input.email,
            phone: input.phone,
            locale: input.locale,
            termsAcceptedAt: new Date(),
          },
        });

    const emailChallengeId = await this.otp.issue(user.id, 'SIGNUP_EMAIL', 'EMAIL', user.email);
    const phoneChallengeId = await this.otp.issue(user.id, 'SIGNUP_PHONE', 'SMS', user.phone);
    return { emailChallengeId, phoneChallengeId };
  }

  async completeSignup(
    input: {
      emailChallengeId: string;
      emailCode: string;
      phoneChallengeId: string;
      phoneCode: string;
    },
    meta: RequestMeta,
  ) {
    const emailUserId = await this.otp.verify(
      input.emailChallengeId,
      input.emailCode,
      'SIGNUP_EMAIL',
    );
    const phoneUserId = await this.otp.verify(
      input.phoneChallengeId,
      input.phoneCode,
      'SIGNUP_PHONE',
    );
    if (emailUserId !== phoneUserId) throw new BadRequestException({ code: 'OTP_INVALID' });

    const now = new Date();
    const activated = await this.prisma.user.updateMany({
      where: { id: emailUserId, status: 'PENDING_VERIFICATION' },
      data: { emailVerifiedAt: now, phoneVerifiedAt: now, status: 'ACTIVE' },
    });
    if (activated.count !== 1) throw new BadRequestException({ code: 'OTP_INVALID' });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: emailUserId } });
    await this.prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
    await this.audit.log({ actorType: 'USER', actorId: user.id, action: 'user.signup', meta });
    return this.createSession(user.id, meta);
  }

  /**
   * Login sends an OTP to the verified phone (and email as a fallback). To avoid account
   * enumeration we always return a challenge id, even for unknown emails.
   */
  async startLogin(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return { challengeId: randomUUID() };
    const challengeId = await this.otp.issue(user.id, 'LOGIN', 'SMS', user.phone);
    return { challengeId };
  }

  async completeLogin(challengeId: string, code: string, meta: RequestMeta) {
    const userId = await this.otp.verify(challengeId, code, 'LOGIN');
    await this.audit.log({ actorType: 'USER', actorId: userId, action: 'user.login', meta });
    return this.createSession(userId, meta);
  }

  async logout(sessionId: string) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  private async createSession(userId: string, meta: RequestMeta) {
    const token = randomToken();
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return { token };
  }
}
