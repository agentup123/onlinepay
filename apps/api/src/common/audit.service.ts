import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@onlinepay/db';
import { redact } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestMeta } from './request';

export interface AuditEntry {
  actorType: 'USER' | 'ADMIN' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  meta?: RequestMeta;
}

const json = (v: unknown) => (v === undefined ? undefined : (redact(v) as Prisma.InputJsonValue));

/** Append-only audit trail for every card, money, KYC and admin action. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          before: json(entry.before),
          after: json(entry.after),
          metadata: json(entry.metadata),
          ip: entry.meta?.ip,
          userAgent: entry.meta?.userAgent,
        },
      });
    } catch (err) {
      // Inside a transaction we want the failure to roll everything back.
      if (tx) throw err;
      this.logger.error(`Failed to write audit log for ${entry.action}`, (err as Error).stack);
    }
  }
}
