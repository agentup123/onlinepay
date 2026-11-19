import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@onlinepay/db';
import { redact } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_JOB_OPTS, QueueService } from '../queue/queue.module';
import { sha256 } from '../common/crypto';

export type WebhookProvider = 'nymcard' | 'checkoutcom' | 'mock-gateway';

/**
 * Inbox pattern: persist every verified webhook once (unique per provider event id), answer the
 * provider immediately, and process asynchronously in the worker with retries.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  async ingest(
    provider: WebhookProvider,
    providerEventId: string,
    eventType: string,
    rawBody: Buffer,
    payload: unknown,
  ) {
    if (!providerEventId) {
      providerEventId = `hash:${sha256(rawBody)}`;
    }
    let eventRowId: string;
    try {
      const row = await this.prisma.webhookEvent.create({
        data: {
          provider,
          providerEventId,
          eventType,
          payloadHash: sha256(rawBody),
          payload: redact(payload) as Prisma.InputJsonValue,
        },
      });
      eventRowId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log(`Duplicate ${provider} webhook ${providerEventId} ignored`);
        return { duplicate: true };
      }
      throw err;
    }

    const queue = provider === 'nymcard' ? this.queues.nymcardEvents : this.queues.paymentEvents;
    await queue.add(
      eventType,
      { webhookEventId: eventRowId },
      { ...DEFAULT_JOB_OPTS, jobId: eventRowId },
    );
    return { duplicate: false, id: eventRowId };
  }

  /** Re-enqueue an event that exhausted its retries (admin action). */
  async retry(webhookEventId: string) {
    const ev = await this.prisma.webhookEvent.findUniqueOrThrow({ where: { id: webhookEventId } });
    const queue = ev.provider === 'nymcard' ? this.queues.nymcardEvents : this.queues.paymentEvents;
    await queue.add(
      ev.eventType,
      { webhookEventId: ev.id },
      { ...DEFAULT_JOB_OPTS, jobId: `${ev.id}:retry:${Date.now()}` },
    );
    return { ok: true };
  }
}
