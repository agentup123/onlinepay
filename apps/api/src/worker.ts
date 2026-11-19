import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Job, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { env } from './config/env';
import { RedactingLogger } from './common/logger';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { CommonModule } from './common/common.module';
import { QueueModule, QueueService, QUEUES, REDIS } from './queue/queue.module';
import { NymCardModule } from './nymcard/nymcard.module';
import { CardsModule } from './cards/cards.module';
import { CardEventsService } from './cards/card-events.service';
import { ReconciliationService } from './cards/reconciliation.service';
import { PaymentsModule } from './payments/payments.module';
import { PaymentsService } from './payments/payments.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './payments/gateway.types';
import { parseNymCardEvent } from './nymcard/nymcard.webhook';
import type { NymCardEvent } from './nymcard/nymcard.types';
import type { GatewayEvent } from './payments/gateway.types';
import { CardsService } from './cards/cards.service';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [PrismaModule, QueueModule, CommonModule, NymCardModule, CardsModule, PaymentsModule],
  providers: [ReconciliationService, WebhooksService],
})
class WorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new RedactingLogger('Worker'),
  });
  const logger = new Logger('Worker');
  const prisma = app.get(PrismaService);
  const cardEvents = app.get(CardEventsService);
  const payments = app.get(PaymentsService);
  const gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  const reconciliation = app.get(ReconciliationService);
  const cards = app.get(CardsService);
  const webhooks = app.get(WebhooksService);
  const queues = app.get(QueueService);
  const connection = app.get<Redis>(REDIS).duplicate({ maxRetriesPerRequest: null });

  /**
   * Loads the stored webhook, runs the handler, and records the outcome. Handlers receive the
   * normalised event captured from the raw body at ingest; the redacted `payload` is only parsed
   * as a fallback for rows stored before `normalized` existed.
   */
  const processInbox = async (
    job: Job<{ webhookEventId: string }>,
    handle: (normalized: unknown, payload: Record<string, unknown>) => Promise<void>,
  ) => {
    const ev = await prisma.webhookEvent.findUnique({ where: { id: job.data.webhookEventId } });
    if (!ev || ev.processedAt) return;
    try {
      await handle(ev.normalized, ev.payload as Record<string, unknown>);
      await prisma.webhookEvent.update({
        where: { id: ev.id },
        data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
      });
    } catch (err) {
      await prisma.webhookEvent.update({
        where: { id: ev.id },
        data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  };

  const workers = [
    new Worker(
      QUEUES.nymcardEvents,
      (job) =>
        processInbox(job, (normalized, payload) =>
          cardEvents.apply((normalized as NymCardEvent | null) ?? parseNymCardEvent(payload)),
        ),
      { connection, concurrency: 10 },
    ),
    new Worker(
      QUEUES.paymentEvents,
      (job) =>
        processInbox(job, (normalized, payload) =>
          payments.handleGatewayEvent(
            (normalized as GatewayEvent | null) ?? gateway.parseWebhook(payload),
          ),
        ),
      { connection, concurrency: 5 },
    ),
    new Worker(
      QUEUES.maintenance,
      async (job) => {
        if (job.name === 'reconcile-cards') {
          await reconciliation.run();
          await payments.expireStalePurchases();
        }
        if (job.name === 'resume-operations') {
          // Finish anything interrupted by a crash or an issuer/gateway timeout.
          const cardOps = await cards.resumeStaleOperations();
          const refunds = await payments.resumeStaleRefunds();
          const webhooksRequeued = await webhooks.sweepUnprocessed();
          logger.log(`Resume: ${JSON.stringify({ ...cardOps, refunds, webhooksRequeued })}`);
        }
        if (job.name === 'cleanup') {
          const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          await prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: cutoff } } });
          await prisma.otpChallenge.deleteMany({ where: { createdAt: { lt: cutoff } } });
        }
      },
      { connection, concurrency: 1 },
    ),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) =>
      logger.warn(
        `Job ${job?.queueName}/${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
      ),
    );
  }

  // Nightly at 02:00 Dubai time.
  await queues.maintenance.upsertJobScheduler(
    'reconcile-cards',
    { pattern: '0 2 * * *', tz: 'Asia/Dubai' },
    { name: 'reconcile-cards' },
  );
  await queues.maintenance.upsertJobScheduler(
    'resume-operations',
    { every: 5 * 60 * 1000 },
    { name: 'resume-operations' },
  );
  await queues.maintenance.upsertJobScheduler(
    'cleanup',
    { pattern: '30 3 * * *', tz: 'Asia/Dubai' },
    { name: 'cleanup' },
  );

  logger.log(`Worker started (NymCard: ${env.NYMCARD_MODE}, gateway: ${env.PAYMENT_GATEWAY})`);

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
