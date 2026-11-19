import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { env } from './config/env';
import { PrismaModule } from './prisma/prisma.service';
import { QueueModule } from './queue/queue.module';
import { CommonModule } from './common/common.module';
import { NymCardModule } from './nymcard/nymcard.module';
import { AuthModule } from './auth/auth.module';
import { KycModule } from './kyc/kyc.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentsModule } from './payments/payments.module';
import { CardsModule } from './cards/cards.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AdminModule } from './admin/admin.module';
import { MeModule } from './me/me.module';
import { DevModule } from './dev/dev.module';

@Controller('health')
@SkipThrottle()
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

const devModules = env.NODE_ENV !== 'production' && env.NYMCARD_MODE === 'mock' ? [DevModule] : [];

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    QueueModule,
    CommonModule,
    NymCardModule,
    AuthModule,
    KycModule,
    WalletModule,
    PaymentsModule,
    CardsModule,
    WebhooksModule,
    AdminModule,
    MeModule,
    ...devModules,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
