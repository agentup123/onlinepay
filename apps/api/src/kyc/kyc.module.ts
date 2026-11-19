import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { User } from '@onlinepay/db';
import { kycSubmitSchema, KycSubmitInput } from '@onlinepay/shared';
import { SessionGuard } from '../auth/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Meta, RequestMeta } from '../common/request';
import { env } from '../config/env';
import {
  KYC_PROVIDER,
  KycProvider,
  MockKycProvider,
  MockScreeningProvider,
  SCREENING_PROVIDER,
} from './kyc.provider';
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

/**
 * Asynchronous decisions from the KYC vendor. Authenticated by the vendor's signature, not by a
 * cookie (the /webhooks prefix is exempt from the origin check).
 */
@Controller('webhooks/kyc')
@SkipThrottle()
export class KycWebhookController {
  constructor(
    private readonly kyc: KycService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    if (!this.provider.verifyWebhook || !this.provider.parseWebhook) throw new NotFoundException();
    const raw = req.rawBody;
    if (!raw || !this.provider.verifyWebhook(raw, req.headers)) {
      throw new UnauthorizedException({ code: 'BAD_SIGNATURE' });
    }
    const decision = this.provider.parseWebhook(req.body as Record<string, unknown>);
    if (!decision) return { ignored: true };
    return this.kyc.applyProviderDecision(decision);
  }
}

/**
 * Wire the vendor NymCard approves here (see docs/KYC_INTEGRATION.md): add a case for its
 * KYC_PROVIDER / SCREENING_PROVIDER value and return your adapter.
 */
function kycProviderFactory(): KycProvider {
  switch (env.KYC_PROVIDER) {
    case 'mock':
      return new MockKycProvider(env.KYC_MOCK_AUTO_APPROVE);
  }
}

function screeningProviderFactory() {
  switch (env.SCREENING_PROVIDER) {
    case 'mock':
      return new MockScreeningProvider();
  }
}

@Module({
  controllers: [KycController, KycWebhookController],
  providers: [
    KycService,
    { provide: KYC_PROVIDER, useFactory: kycProviderFactory },
    { provide: SCREENING_PROVIDER, useFactory: screeningProviderFactory },
  ],
  exports: [KycService],
})
export class KycModule {}
