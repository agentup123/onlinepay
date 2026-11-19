import { Body, Controller, Get, Headers, Module, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import type { User } from '@onlinepay/db';
import { walletTopUpSchema } from '@onlinepay/shared';
import { SessionGuard } from '../auth/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Meta, RequestMeta } from '../common/request';
import { Idempotent, IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { env } from '../config/env';
import { KycModule } from '../kyc/kyc.module';
import { WalletModule } from '../wallet/wallet.module';
import { CheckoutComGateway } from './checkoutcom.gateway';
import { PAYMENT_GATEWAY } from './gateway.types';
import { InvoiceService } from './invoice.service';
import { MockGateway } from './mock.gateway';
import { PaymentsService } from './payments.service';

const bundleCheckoutSchema = z.object({ bundleCode: z.string().default('CARDS_30') });

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('bundles')
  bundles() {
    return this.payments.listBundles();
  }

  @Post('payments/bundle/checkout')
  @UseGuards(SessionGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  checkoutBundle(
    @CurrentUser() user: User,
    @Body(new ZodPipe(bundleCheckoutSchema)) body: z.infer<typeof bundleCheckoutSchema>,
    @Headers('idempotency-key') key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payments.checkoutBundle(user, body.bundleCode, key, meta);
  }

  @Post('payments/wallet/checkout')
  @UseGuards(SessionGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  checkoutTopUp(
    @CurrentUser() user: User,
    @Body(new ZodPipe(walletTopUpSchema)) body: z.infer<typeof walletTopUpSchema>,
    @Headers('idempotency-key') key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payments.checkoutTopUp(user, body.amountFils, key, meta);
  }

  @Get('payments/:id')
  @UseGuards(SessionGuard)
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.getPurchase(user.id, id);
  }
}

@Module({
  imports: [KycModule, WalletModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    InvoiceService,
    {
      provide: PAYMENT_GATEWAY,
      useFactory: () =>
        env.PAYMENT_GATEWAY === 'mock'
          ? new MockGateway()
          : new CheckoutComGateway({
              baseUrl: env.CHECKOUTCOM_BASE_URL,
              secretKey: env.CHECKOUTCOM_SECRET_KEY ?? '',
              processingChannelId: env.CHECKOUTCOM_PROCESSING_CHANNEL_ID ?? '',
              webhookSecret: env.CHECKOUTCOM_WEBHOOK_SECRET ?? '',
            }),
    },
  ],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
