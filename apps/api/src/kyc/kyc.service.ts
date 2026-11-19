import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { KycSubmitInput } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { RequestMeta } from '../common/request';
import { NYMCARD_CLIENT, NymCardClient } from '../nymcard/nymcard.types';
import { KYC_PROVIDER, KycProvider } from './kyc.provider';

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
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

  async assertApproved(userId: string) {
    const approved = await this.prisma.kycApplication.findFirst({
      where: { userId, status: 'APPROVED' },
    });
    if (!approved) throw new ForbiddenException({ code: 'KYC_REQUIRED' });
  }

  async submit(userId: string, input: KycSubmitInput, meta: RequestMeta) {
    const open = await this.prisma.kycApplication.findFirst({
      where: { userId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (open) throw new ConflictException({ code: 'KYC_ALREADY_SUBMITTED', status: open.status });

    const result = await this.provider.submit(userId, input);
    const app = await this.prisma.kycApplication.create({
      data: {
        userId,
        provider: this.provider.name,
        providerRef: result.providerRef,
        documentType: input.documentType,
        nationality: input.nationality,
        dateOfBirth: new Date(input.dateOfBirth),
        status: result.status,
        reviewedAt: result.status === 'PENDING' ? null : new Date(),
      },
    });
    await this.audit.log({
      actorType: 'USER',
      actorId: userId,
      action: 'kyc.submit',
      targetType: 'KycApplication',
      targetId: app.id,
      after: { status: app.status, documentType: app.documentType },
      meta,
    });
    if (app.status === 'APPROVED') await this.onApproved(app.id);
    return { status: app.status };
  }

  /** Manual review by compliance (also used for the mock provider when auto-approve is off). */
  async decide(
    applicationId: string,
    decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO',
    note: string | undefined,
    adminId: string,
    meta: RequestMeta,
  ) {
    const app = await this.prisma.kycApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException();
    if (app.status === 'APPROVED') throw new ConflictException({ code: 'ALREADY_APPROVED' });

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
      before: { status: app.status },
      after: { status: decision, note },
      meta,
    });
    if (decision === 'APPROVED') await this.onApproved(app.id);
    else {
      await this.notifications.notify({
        userId: app.userId,
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
    }
    return updated;
  }

  /** On approval, register the cardholder with NymCard so cards can be issued. */
  private async onApproved(applicationId: string) {
    const app = await this.prisma.kycApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { user: true },
    });
    if (!app.user.nymcardHolderId) {
      const { cardholderId } = await this.nymcard.createCardholder({
        externalRef: app.user.id,
        fullName: app.user.fullName,
        email: app.user.email,
        phone: app.user.phone,
        dateOfBirth: app.dateOfBirth.toISOString().slice(0, 10),
        nationality: app.nationality,
      });
      await this.prisma.user.update({
        where: { id: app.user.id },
        data: { nymcardHolderId: cardholderId },
      });
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
}
