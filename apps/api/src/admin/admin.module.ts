import { Module } from '@nestjs/common';
import { CardsModule } from '../cards/cards.module';
import { KycModule } from '../kyc/kyc.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AdminAuthService, AdminGuard } from './admin-auth';
import { AdminAuthController, AdminController } from './admin.controller';

@Module({
  imports: [CardsModule, KycModule, PaymentsModule, WebhooksModule],
  controllers: [AdminAuthController, AdminController],
  providers: [AdminAuthService, AdminGuard],
})
export class AdminModule {}
