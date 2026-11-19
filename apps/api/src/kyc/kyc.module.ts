import { Body, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import type { User } from '@onlinepay/db';
import { kycSubmitSchema, KycSubmitInput } from '@onlinepay/shared';
import { SessionGuard } from '../auth/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Meta, RequestMeta } from '../common/request';
import { env } from '../config/env';
import { KYC_PROVIDER, MockKycProvider } from './kyc.provider';
import { KycService } from './kyc.service';

@Controller('kyc')
@UseGuards(SessionGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  status(@CurrentUser() user: User) {
    return this.kyc.status(user.id);
  }

  @Post()
  submit(
    @CurrentUser() user: User,
    @Body(new ZodPipe(kycSubmitSchema)) body: KycSubmitInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.kyc.submit(user.id, body, meta);
  }
}

@Module({
  controllers: [KycController],
  providers: [
    KycService,
    { provide: KYC_PROVIDER, useFactory: () => new MockKycProvider(env.KYC_MOCK_AUTO_APPROVE) },
  ],
  exports: [KycService],
})
export class KycModule {}
