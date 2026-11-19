import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { User } from '@onlinepay/db';
import { env } from '../config/env';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WebhooksService } from '../webhooks/webhooks.service';

const simulateSchema = z.object({
  cardId: z.string().uuid(),
  amountFils: z.number().int().positive(),
  merchantName: z.string().default('DEMO MERCHANT'),
  mcc: z.string().default('5999'),
  outcome: z.enum(['approved', 'declined']).default('approved'),
});

/**
 * Development helpers, only mounted when NYMCARD_MODE=mock and NODE_ENV!=production.
 * Lets you simulate card transactions end-to-end through the real webhook pipeline.
 */
@Controller('dev')
@UseGuards(SessionGuard)
export class DevController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('simulate-transaction')
  @HttpCode(200)
  async simulate(
    @CurrentUser() user: User,
    @Body(new ZodPipe(simulateSchema)) body: z.infer<typeof simulateSchema>,
  ) {
    if (env.NYMCARD_MODE !== 'mock' || env.NODE_ENV === 'production')
      throw new ForbiddenException();
    const card = await this.prisma.card.findFirst({ where: { id: body.cardId, userId: user.id } });
    if (!card) throw new ForbiddenException();

    const txnId = `mock-txn-${randomUUID()}`;
    const events =
      body.outcome === 'declined'
        ? [{ type: 'transaction.declined', decline_reason: 'Insufficient funds' }]
        : [{ type: 'transaction.authorization' }, { type: 'transaction.settlement' }];
    for (const e of events) {
      const payload = {
        id: `mock-evt-${randomUUID()}`,
        type: e.type,
        data: {
          card_id: card.nymcardCardId,
          transaction_id: txnId,
          amount: body.amountFils,
          merchant_name: body.merchantName,
          merchant_country: 'AE',
          mcc: body.mcc,
          decline_reason: 'decline_reason' in e ? e.decline_reason : undefined,
          occurred_at: new Date().toISOString(),
        },
      };
      const raw = Buffer.from(JSON.stringify(payload));
      await this.webhooks.ingest('nymcard', payload.id, payload.type, raw, payload);
    }
    return { transactionId: txnId };
  }
}

@Module({ imports: [WebhooksModule], controllers: [DevController] })
export class DevModule {}
