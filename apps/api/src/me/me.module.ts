import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { User } from '@onlinepay/db';
import { localeSchema } from '@onlinepay/shared';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, Meta, RequestMeta } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

const disputeSchema = z.object({
  transactionId: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000),
});
const prefsSchema = z.object({ locale: localeSchema });

/** Signed-in consumer: invoices, notifications, preferences, disputes. */
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Patch('preferences')
  async prefs(
    @CurrentUser() user: User,
    @Body(new ZodPipe(prefsSchema)) body: z.infer<typeof prefsSchema>,
  ) {
    await this.prisma.user.update({ where: { id: user.id }, data: { locale: body.locale } });
    return { ok: true };
  }

  @Get('invoices')
  invoices(@CurrentUser() user: User) {
    return this.prisma.invoice.findMany({
      where: { userId: user.id },
      orderBy: { issuedAt: 'desc' },
    });
  }

  @Get('invoices/:id')
  async invoice(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, userId: user.id },
      include: { user: { select: { fullName: true, email: true } } },
    });
    if (!invoice) throw new NotFoundException();
    return invoice;
  }

  @Get('notifications')
  list(@CurrentUser() user: User) {
    return this.notifications.list(user.id);
  }

  @Post('notifications/read')
  @HttpCode(200)
  read(@CurrentUser() user: User) {
    return this.notifications.markAllRead(user.id);
  }

  @Post('disputes')
  async dispute(
    @CurrentUser() user: User,
    @Body(new ZodPipe(disputeSchema)) body: z.infer<typeof disputeSchema>,
    @Meta() meta: RequestMeta,
  ) {
    const txn = await this.prisma.cardTransaction.findFirst({
      where: { id: body.transactionId, card: { userId: user.id } },
    });
    if (!txn) throw new NotFoundException();
    const d = await this.prisma.dispute.create({
      data: { userId: user.id, transactionId: txn.id, reason: body.reason },
    });
    await this.audit.log({
      actorType: 'USER',
      actorId: user.id,
      action: 'dispute.open',
      targetType: 'Dispute',
      targetId: d.id,
      meta,
    });
    return d;
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
