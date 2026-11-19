import { BadRequestException, Injectable } from '@nestjs/common';
import { TooManyRequestsException } from '../common/errors';
import type { OtpChannel, OtpPurpose } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { hmacSha256, randomOtp, safeEqualHex } from '../common/crypto';
import { env } from '../config/env';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  async issue(userId: string, purpose: OtpPurpose, channel: OtpChannel, destination: string) {
    const recent = await this.prisma.otpChallenge.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= MAX_SENDS_PER_HOUR) {
      throw new TooManyRequestsException({ code: 'OTP_RATE_LIMITED' });
    }

    const code = randomOtp();
    const challenge = await this.prisma.otpChallenge.create({
      data: {
        userId,
        purpose,
        channel,
        destination,
        codeHash: hmacSha256(env.OTP_PEPPER, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    const text = `OnlinePay code: ${code}. Valid for 5 minutes. Never share this code.`;
    if (channel === 'SMS') await this.messaging.sendSms(destination, text);
    else await this.messaging.sendEmail(destination, 'Your OnlinePay verification code', text);

    return challenge.id;
  }

  /** Verifies and consumes a challenge. Returns its userId. Errors are deliberately generic. */
  async verify(challengeId: string, code: string, purpose: OtpPurpose): Promise<string> {
    const challenge = await this.prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    const invalid = new BadRequestException({ code: 'OTP_INVALID' });
    if (!challenge || challenge.purpose !== purpose || challenge.consumedAt) throw invalid;
    if (challenge.expiresAt < new Date()) throw new BadRequestException({ code: 'OTP_EXPIRED' });
    if (challenge.attempts >= challenge.maxAttempts) {
      throw new TooManyRequestsException({ code: 'OTP_TOO_MANY_ATTEMPTS' });
    }

    const ok = safeEqualHex(hmacSha256(env.OTP_PEPPER, code), challenge.codeHash);
    if (!ok) {
      await this.prisma.otpChallenge.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 } },
      });
      throw invalid;
    }
    // Atomic consume: only one concurrent request can succeed.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
    return challenge.userId;
  }
}
