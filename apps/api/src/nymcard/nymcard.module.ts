import { Global, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { env } from '../config/env';
import { REDIS } from '../queue/queue.module';
import { NymCardHttpClient } from './nymcard.http';
import { NymCardMockClient } from './nymcard.mock';
import { NYMCARD_CLIENT, NymCardClient } from './nymcard.types';

@Global()
@Module({
  providers: [
    {
      provide: NYMCARD_CLIENT,
      inject: [REDIS],
      useFactory: (redis: Redis): NymCardClient =>
        env.NYMCARD_MODE === 'mock'
          ? new NymCardMockClient(redis)
          : new NymCardHttpClient({
              baseUrl: env.NYMCARD_BASE_URL ?? '',
              apiKey: env.NYMCARD_API_KEY ?? '',
              apiSecret: env.NYMCARD_API_SECRET,
              productId: env.NYMCARD_PRODUCT_ID,
            }),
    },
  ],
  exports: [NYMCARD_CLIENT],
})
export class NymCardModule {}
