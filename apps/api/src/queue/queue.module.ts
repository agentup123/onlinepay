import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';

export const REDIS = Symbol('REDIS');

export const QUEUES = {
  nymcardEvents: 'nymcard-events',
  paymentEvents: 'payment-events',
  maintenance: 'maintenance',
} as const;

export const DEFAULT_JOB_OPTS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: false, // keep failed jobs as a dead-letter record
};

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly nymcardEvents: Queue;
  readonly paymentEvents: Queue;
  readonly maintenance: Queue;

  constructor(@Inject(REDIS) redis: Redis) {
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    this.nymcardEvents = new Queue(QUEUES.nymcardEvents, { connection });
    this.paymentEvents = new Queue(QUEUES.paymentEvents, { connection });
    this.maintenance = new Queue(QUEUES.maintenance, { connection });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.nymcardEvents.close(),
      this.paymentEvents.close(),
      this.maintenance.close(),
    ]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    },
    QueueService,
  ],
  exports: [REDIS, QueueService],
})
export class QueueModule {}
