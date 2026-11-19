import { Injectable } from '@nestjs/common';
import type { NotificationType } from '@onlinepay/db';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  en: { title: string; body: string };
  ar: { title: string; body: string };
  email?: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    const n = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        titleEn: input.en.title,
        bodyEn: input.en.body,
        titleAr: input.ar.title,
        bodyAr: input.ar.body,
      },
      include: { user: { select: { email: true, locale: true } } },
    });
    if (input.email !== false) {
      const t = n.user.locale === 'ar' ? input.ar : input.en;
      await this.messaging.sendEmail(n.user.email, t.title, t.body);
    }
  }

  list(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
