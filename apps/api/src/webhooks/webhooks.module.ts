import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { ZodPipe } from '../common/zod.pipe';
import { parseNymCardEvent, verifyNymCardSignature } from '../nymcard/nymcard.webhook';
import { PaymentsModule } from '../payments/payments.module';
import { PAYMENT_GATEWAY, PaymentGateway } from '../payments/gateway.types';
import { WebhooksService } from './webhooks.service';

const mockCompleteSchema = z.object({
  sessionId: z.string().startsWith('mock-sess-'),
  outcome: z.enum(['success', 'failure']),
  amountFils: z.number().int().nonnegative(),
});

@Controller('webhooks')
@SkipThrottle()
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  @Post('nymcard')
  @HttpCode(200)
  async nymcard(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    const signature = req.header(env.NYMCARD_WEBHOOK_SIGNATURE_HEADER);
    if (!raw || !verifyNymCardSignature(raw, signature, env.NYMCARD_WEBHOOK_SECRET)) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE' });
    }
    const body = req.body as Record<string, unknown>;
    const parsed = parseNymCardEvent(body);
    const type = parsed.kind === 'unknown' ? parsed.type : String(body.type);
    return this.webhooks.ingest('nymcard', parsed.eventId, type, raw, body);
  }

  @Post('payments/checkoutcom')
  @HttpCode(200)
  async checkoutcom(@Req() req: RawBodyRequest<Request>) {
    if (this.gateway.name !== 'checkoutcom') throw new NotFoundException();
    const raw = req.rawBody;
    if (!raw || !this.gateway.verifyWebhook(raw, req.headers)) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE' });
    }
    const body = req.body as Record<string, unknown>;
    return this.webhooks.ingest(
      'checkoutcom',
      String(body.id ?? ''),
      String(body.type ?? 'unknown'),
      raw,
      body,
    );
  }

  /** Dev-only: the mock hosted payment page reports its outcome here. */
  @Post('payments/mock/complete')
  @HttpCode(200)
  async mockComplete(
    @Req() req: RawBodyRequest<Request>,
    @Body(new ZodPipe(mockCompleteSchema)) body: z.infer<typeof mockCompleteSchema>,
  ) {
    if (this.gateway.name !== 'mock' || env.NODE_ENV === 'production')
      throw new ForbiddenException();
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    return this.webhooks.ingest(
      'mock-gateway',
      `${body.sessionId}:${body.outcome}`,
      `mock.${body.outcome}`,
      raw,
      body,
    );
  }
}

@Module({
  imports: [PaymentsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
