import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@onlinepay/db';
import { redact } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_JOB_OPTS, QueueService } from '../queue/queue.module';
import { sha256 } from '../common/crypto';

export type WebhookProvider = 'nymcard' | 'checkoutcom' | 'mock-gateway';

/** Unprocessed events older than this are re-enqueued by the worker's sweeper. */
export const STALE_WEBHOOK_MS = 5 * 60 * 1000;

/**
 * Inbox pattern: persist every verified webhook once (unique per provider event id), answer the
 * provider immediately, and process asynchronously in the worker with retries.
 *
 * Two copies are kept: `payload` is the redacted raw body (for audit/support), and `normalized`
 * is the provider-neutral event parsed from the raw body, which is what the worker processes.
 * Processing the redacted copy would corrupt identifiers that merely look like card numbers.
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
    normalized?: unknown,
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
          normalized:
            normalized === undefined ? Prisma.JsonNull : (normalized as Prisma.InputJsonValue),
        },
      });
      eventRowId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // A redelivery. If our first attempt stored the row but never got it onto the queue
        // (e.g. Redis was down), this is our chance to recover it.
        const existing = await this.prisma.webhookEvent.findUnique({
          where: { provider_providerEventId: { provider, providerEventId } },
        });
        if (existing && !existing.processedAt) {
          await this.enqueue(existing.provider, existing.eventType, existing.id, `redeliver`);
        }
        this.logger.log(`Duplicate ${provider} webhook ${providerEventId} ignored`);
        return { duplicate: true };
      }
      throw err;
    }

    await this.enqueue(provider, eventType, eventRowId);
    return { duplicate: false, id: eventRowId };
  }

  /**
   * Enqueues an inbox row. The first enqueue uses the row id as job id (BullMQ dedupes); later
   * attempts get a unique suffix so a job kept in the failed set doesn't swallow them. Processing
   * is idempotent (processedAt check + idempotent handlers), so an extra delivery is harmless.
   */
  private async enqueue(provider: string, eventType: string, rowId: string, reason?: string) {
    const queue = provider === 'nymcard' ? this.queues.nymcardEvents : this.queues.paymentEvents;
    const jobId = reason ? `${rowId}:${reason}:${Date.now()}` : rowId;
    await queue.add(eventType, { webhookEventId: rowId }, { ...DEFAULT_JOB_OPTS, jobId });
  }

  /** Re-enqueue an event that exhausted its retries (admin action). */
  async retry(webhookEventId: string) {
    const ev = await this.prisma.webhookEvent.findUniqueOrThrow({ where: { id: webhookEventId } });
    await this.enqueue(ev.provider, ev.eventType, ev.id, 'retry');
    return { ok: true };
  }

  /** Worker sweeper: re-enqueues stored events that were never picked up (enqueue lost). */
  async sweepUnprocessed(now = new Date()) {
    const stale = await this.prisma.webhookEvent.findMany({
      where: {
        processedAt: null,
        receivedAt: { lt: new Date(now.getTime() - STALE_WEBHOOK_MS) },
        // Only events no worker ever picked up; failing ones are retried by BullMQ and then
        // surface in the admin "failed webhooks" view.
        attempts: 0,
      },
      orderBy: { receivedAt: 'asc' },
      take: 200,
    });
    for (const ev of stale) {
      await this.enqueue(ev.provider, ev.eventType, ev.id, 'sweep');
    }
    return stale.length;
  }
}
