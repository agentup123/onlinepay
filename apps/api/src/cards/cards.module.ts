import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { User } from '@onlinepay/db';
import { createCardSchema, fundCardSchema, renameCardSchema, setLimitSchema } from '@onlinepay/shared';
import { SessionGuard } from '../auth/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Meta, RequestMeta } from '../common/request';
import { Idempotent, IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { KycModule } from '../kyc/kyc.module';
import { WalletModule } from '../wallet/wallet.module';
import { CardsService } from './cards.service';
import { CardEventsService } from './card-events.service';

const CARD_ACTIONS = { default: { limit: 20, ttl: 60_000 } };

@Controller('cards')
@UseGuards(SessionGuard)
@UseInterceptors(IdempotencyInterceptor)
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.cards.list(user.id);
  }

  @Post()
  @Idempotent()
  @Throttle(CARD_ACTIONS)
  create(
    @CurrentUser() user: User,
    @Body(new ZodPipe(createCardSchema)) body: z.infer<typeof createCardSchema>,
    @Headers('idempotency-key') key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.cards.create(user, body, key, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.get(user.id, id);
  }

  @Get(':id/transactions')
  transactions(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.transactions(user.id, id);
  }

  @Patch(':id')
  rename(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(renameCardSchema)) body: z.infer<typeof renameCardSchema>,
    @Meta() meta: RequestMeta,
  ) {
    return this.cards.rename(user.id, id, body.label, meta);
  }

  @Post(':id/freeze')
  @HttpCode(200)
  @Throttle(CARD_ACTIONS)
  freeze(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.cards.setFrozen({ type: 'USER', id: user.id }, user.id, id, true, meta);
  }

  @Post(':id/unfreeze')
  @HttpCode(200)
  @Throttle(CARD_ACTIONS)
  unfreeze(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.cards.setFrozen({ type: 'USER', id: user.id }, user.id, id, false, meta);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @Throttle(CARD_ACTIONS)
  cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.cards.cancel({ type: 'USER', id: user.id }, user.id, id, meta);
  }

  @Post(':id/limit')
  @HttpCode(200)
  setLimit(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setLimitSchema)) body: z.infer<typeof setLimitSchema>,
    @Meta() meta: RequestMeta,
  ) {
    return this.cards.setLimit({ type: 'USER', id: user.id }, user.id, id, body.spendingLimitFils, meta);
  }

  @Post(':id/fund')
  @HttpCode(200)
  @Idempotent()
  @Throttle(CARD_ACTIONS)
  fund(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(fundCardSchema)) body: z.infer<typeof fundCardSchema>,
    @Headers('idempotency-key') key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.cards.fund(user.id, id, body.amountFils, key, meta);
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reveal(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    return this.cards.reveal(user.id, id, meta);
  }
}

@Module({
  imports: [KycModule, WalletModule],
  controllers: [CardsController],
  providers: [CardsService, CardEventsService],
  exports: [CardsService, CardEventsService],
})
export class CardsModule {}
