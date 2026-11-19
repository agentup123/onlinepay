import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { KycApplication } from '@onlinepay/db';
import { ageOn, MIN_CARDHOLDER_AGE, type KycSubmitInput } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { RequestMeta } from '../common/request';
import { NYMCARD_CLIENT, NymCardClient } from '../nymcard/nymcard.types';
import {
  KYC_PROVIDER,
  KycDecision,
  KycProvider,
  KycWebhookDecision,
  SCREENING_PROVIDER,
  ScreeningProvider,
  ScreeningResult,
  VerifiedIdentity,
} from './kyc.provider';

/** Approved customers are re-screened at least this often (vendors with ongoing monitoring
 * push changes sooner via webhook). Agree the cadence with your MLRO. */
export const RESCREEN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    @Inject(SCREENING_PROVIDER) private readonly screening: ScreeningProvider,
    @Inject(NYMCARD_CLIENT) private readonly nymcard: NymCardClient,
  ) {}

  async status(userId: string) {
    const latest = await this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, documentType: true, reviewNote: true, createdAt: true },
    });
    return latest ?? { status: 'NOT_STARTED' as const };
  }

  private latest(userId: string) {
    return this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Only the user's LATEST application counts, so a revoked approval really revokes access. */
  async assertApproved(userId: string) {
    const latest = await this.latest(userId);
    if (latest?.status !== 'APPROVED') throw new ForbiddenException({ code: 'KYC_REQUIRED' });
  }

  /**
   * Returns the user's NymCard cardholder id, creating it if approval happened but the
   * cardholder call failed at the time (NymCard down). Idempotent on NymCard's side via the
   * `holder-<userId>` key, so callers can invoke it freely.
   */
  async ensureCardholder(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.nymcardHolderId) return user.nymcardHolderId;
    const app = await this.latest(userId);
    if (app?.status !== 'APPROVED') throw new ForbiddenException({ code: 'KYC_REQUIRED' });
    try {
      const { cardholderId } = await this.nymcard.createCardholder({
        externalRef: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        dateOfBirth: isoDate(app.dateOfBirth),
        nationality: app.nationality,
      });
      await this.prisma.user.update({
        where: { id: user.id },
        data: { nymcardHolderId: cardholderId },
      });
      return cardholderId;
    } catch (err) {
      this.logger.warn(`Cardholder creation failed for user ${user.id}: ${(err as Error).message}`);
      throw new ServiceUnavailableException({ code: 'CARDHOLDER_NOT_READY' });
    }
  }

  async submit(userId: string, input: KycSubmitInput, meta: RequestMeta) {
    const latest = await this.latest(userId);
    if (latest && (latest.status === 'PENDING' || latest.status === 'APPROVED')) {
      throw new ConflictException({ code: 'KYC_ALREADY_SUBMITTED', status: latest.status });
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const result = await this.provider.submit(
      { userId, fullName: user.fullName, email: user.email, phone: user.phone },
      input,
    );
    const app = await this.prisma.kycApplication.create({
      data: {
        userId,
        provider: this.provider.name,
        providerRef: result.providerRef,
        documentType: input.documentType,
        // Provider-verified data wins over what the user typed.
        nationality: (result.verified?.nationality ?? input.nationality).toUpperCase(),
        dateOfBirth: new Date(result.verified?.dateOfBirth ?? input.dateOfBirth),
        status: 'PENDING',
      },
    });
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'kyc.submit',
      targetType: 'KycApplication',
      targetId: app.id,
      after: { status: result.status, documentType: app.documentType },
      meta,
    });
    const final = await this.applyDecision(app, result.status, undefined, 'provider');
    return { status: final.status };
  }

  /** Asynchronous decision pushed by the KYC provider's webhook (signature already verified). */
  async applyProviderDecision(decision: KycWebhookDecision) {
    const app = await this.prisma.kycApplication.findUnique({
      where: {
        provider_providerRef: { provider: this.provider.name, providerRef: decision.providerRef },
      },
    });
    if (!app) throw new NotFoundException({ code: 'KYC_APPLICATION_NOT_FOUND' });
    // Final states are only changed by compliance (decide), never by a replayed webhook.
    if (app.status !== 'PENDING' && app.status !== 'NEEDS_INFO') return { status: app.status };
    const updated = decision.verified ? await this.applyVerified(app, decision.verified) : app;
    const final = await this.applyDecision(
      updated,
      decision.status,
      decision.reviewNote,
      'provider',
    );
    return { status: final.status };
  }

  private applyVerified(app: KycApplication, verified: VerifiedIdentity) {
    return this.prisma.kycApplication.update({
      where: { id: app.id },
      data: {
        ...(verified.dateOfBirth ? { dateOfBirth: new Date(verified.dateOfBirth) } : {}),
        ...(verified.nationality ? { nationality: verified.nationality.toUpperCase() } : {}),
      },
    });
  }

  /**
   * The single gate every provider decision goes through. An APPROVED decision only becomes
   * APPROVED after the age check and a CLEAR sanctions/PEP screening; otherwise the application
   * stays PENDING for compliance, with a flag.
   */
  private async applyDecision(
    app: KycApplication,
    proposed: KycDecision,
    note: string | undefined,
    source: 'provider',
  ): Promise<KycApplication> {
    if (proposed === 'PENDING') return app;
    if (proposed === 'REJECTED') {
      const rejected = await this.setStatus(app, 'REJECTED', note ?? 'Rejected by KYC provider');
      await this.notifyDecision(rejected.userId, 'REJECTED');
      return rejected;
    }

    if (ageOn(isoDate(app.dateOfBirth)) < MIN_CARDHOLDER_AGE) {
      const rejected = await this.setStatus(app, 'REJECTED', 'Under minimum age');
      await this.notifyDecision(rejected.userId, 'REJECTED');
      return rejected;
    }

    const screening = await this.runScreening(app);
    if (screening.status !== 'CLEAR') {
      return this.setStatus(
        app,
        'PENDING',
        screening.status === 'ERROR'
          ? 'Sanctions/PEP screening unavailable — retry or review manually'
          : `Sanctions/PEP screening: ${screening.summary ?? 'potential match'} — compliance review`,
      );
    }
    const approved = await this.setStatus(app, 'APPROVED', note);
    this.logger.log(`KYC ${app.id} approved by ${source}`);
    await this.onApproved(approved.id);
    return approved;
  }

  private setStatus(app: KycApplication, status: KycApplication['status'], note?: string) {
    return this.prisma.kycApplication.update({
      where: { id: app.id },
      data: {
        status,
        reviewNote: note ?? app.reviewNote,
        reviewedAt: status === 'PENDING' ? app.reviewedAt : new Date(),
      },
    });
  }

  /** Screens the applicant, records the result, and flags anything that isn't CLEAR. */
  private async runScreening(app: KycApplication): Promise<ScreeningResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: app.userId } });
    let result: ScreeningResult;
    try {
      result = await this.screening.screen({
        userId: user.id,
        fullName: user.fullName,
        dateOfBirth: isoDate(app.dateOfBirth),
        nationality: app.nationality,
      });
    } catch (err) {
      this.logger.warn(`Screening failed for KYC ${app.id}: ${(err as Error).message}`);
      result = { status: 'ERROR', ref: 'unavailable' };
    }
    await this.prisma.kycApplication.update({
      where: { id: app.id },
      data: {
        screeningStatus: result.status,
        screeningRef: result.ref,
        screeningSummary: result.summary ?? null,
        screenedAt: new Date(),
      },
    });
    if (result.status !== 'CLEAR') {
      await this.prisma.suspiciousActivityFlag.create({
        data: {
          userId: app.userId,
          rule: result.status === 'ERROR' ? 'SCREENING_ERROR' : 'SCREENING_MATCH',
          details: {
            kycApplicationId: app.id,
            provider: this.screening.name,
            screeningRef: result.ref,
            summary: result.summary ?? null,
          },
        },
      });
    }
    await this.audit.log({
      actorType: 'SYSTEM',
      action: 'kyc.screening',
      targetType: 'KycApplication',
      targetId: app.id,
      after: { status: result.status, ref: result.ref },
    });
    return result;
  }

  /**
   * Manual review by compliance (also used for the mock provider when auto-approve is off).
   *
   * - APPROVED requires a CLEAR screening. If screening found a potential match, compliance can
   *   still approve after review (a documented false positive) but must give a note. If
   *   screening is unavailable it is re-run; approval waits until it succeeds.
   * - An APPROVED application can be revoked (REJECTED / NEEDS_INFO); because only the latest
   *   application counts, that immediately blocks new purchases and cards. Compliance should
   *   also suspend the user to freeze existing cards.
   */
  async decide(
    applicationId: string,
    decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO',
    note: string | undefined,
    adminId: string,
    meta: RequestMeta,
  ) {
    let app = await this.prisma.kycApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException();
    if (app.status === decision) throw new ConflictException({ code: `ALREADY_${decision}` });

    let screeningCleared = false;
    if (decision === 'APPROVED') {
      if (ageOn(isoDate(app.dateOfBirth)) < MIN_CARDHOLDER_AGE) {
        throw new ConflictException({ code: 'KYC_UNDER_MINIMUM_AGE' });
      }
      if (app.screeningStatus !== 'CLEAR' && app.screeningStatus !== 'POTENTIAL_MATCH') {
        await this.runScreening(app);
        app = await this.prisma.kycApplication.findUniqueOrThrow({ where: { id: app.id } });
      }
      if (app.screeningStatus === 'ERROR') {
        throw new ServiceUnavailableException({ code: 'SCREENING_UNAVAILABLE' });
      }
      if (app.screeningStatus === 'POTENTIAL_MATCH') {
        if (!note || note.trim().length < 10) {
          throw new ConflictException({ code: 'SCREENING_MATCH_NOTE_REQUIRED' });
        }
        screeningCleared = true;
      }
    }

    const updated = await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        status: decision,
        reviewNote: note,
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
      },
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: `admin.kyc.${decision.toLowerCase()}`,
      targetType: 'KycApplication',
      targetId: app.id,
      before: { status: app.status, screeningStatus: app.screeningStatus },
      after: { status: decision, note, screeningCleared },
      meta,
    });
    if (decision === 'APPROVED') await this.onApproved(app.id);
    else await this.notifyDecision(app.userId, decision);
    return updated;
  }

  private async notifyDecision(userId: string, decision: 'REJECTED' | 'NEEDS_INFO') {
    if (decision === 'NEEDS_INFO') {
      await this.notifications.notify({
        userId,
        type: 'KYC',
        en: {
          title: 'Identity verification update',
          body: 'We need more information to verify your identity. Please check your dashboard.',
        },
        ar: {
          title: 'تحديث التحقق من الهوية',
          body: 'نحتاج إلى مزيد من المعلومات للتحقق من هويتك. يرجى مراجعة لوحة التحكم.',
        },
      });
      return;
    }
    await this.notifications.notify({
      userId,
      type: 'KYC',
      en: {
        title: 'Identity verification unsuccessful',
        body: 'We could not verify your identity. Please contact support if you think this is a mistake.',
      },
      ar: {
        title: 'لم يتم التحقق من الهوية',
        body: 'لم نتمكن من التحقق من هويتك. يرجى التواصل مع الدعم إذا كنت تعتقد أن هذا خطأ.',
      },
    });
  }

  /** On approval, register the cardholder with NymCard so cards can be issued. */
  private async onApproved(applicationId: string) {
    const app = await this.prisma.kycApplication.findUniqueOrThrow({
      where: { id: applicationId },
    });
    try {
      await this.ensureCardholder(app.userId);
    } catch {
      // Approval stands; ensureCardholder() is retried at checkout and card creation.
    }
    await this.notifications.notify({
      userId: app.userId,
      type: 'KYC',
      en: {
        title: 'You are verified',
        body: 'Your identity is verified. You can now buy a bundle and create cards.',
      },
      ar: {
        title: 'تم التحقق من هويتك',
        body: 'تم التحقق من هويتك. يمكنك الآن شراء باقة وإنشاء البطاقات.',
      },
    });
  }

  /**
   * Ongoing screening (worker, nightly): re-screens approved customers whose last screening is
   * older than RESCREEN_AFTER_MS. A new hit raises a SCREENING_MATCH flag for compliance; it does
   * not block the customer automatically (compliance decides, and suspends if needed).
   */
  async rescreenApproved(now = new Date(), limit = 500) {
    const due = await this.prisma.kycApplication.findMany({
      where: {
        status: 'APPROVED',
        OR: [
          { screenedAt: null },
          { screenedAt: { lt: new Date(now.getTime() - RESCREEN_AFTER_MS) } },
        ],
      },
      orderBy: { screenedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
    const counts = { screened: 0, matches: 0, errors: 0 };
    for (const app of due) {
      // Only the latest application per user matters.
      const latest = await this.latest(app.userId);
      if (latest?.id !== app.id) continue;
      const result = await this.runScreening(app);
      counts.screened++;
      if (result.status === 'POTENTIAL_MATCH') counts.matches++;
      if (result.status === 'ERROR') counts.errors++;
    }
    return counts;
  }
}
