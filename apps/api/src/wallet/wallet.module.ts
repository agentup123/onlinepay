import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import type { User } from '@onlinepay/db';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../common/request';
import { WalletService } from './wallet.service';

@Controller('wallet')
@UseGuards(SessionGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  get(@CurrentUser() user: User) {
    return this.wallet.get(user.id);
  }
}

@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
