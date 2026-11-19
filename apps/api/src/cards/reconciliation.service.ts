import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NYMCARD_CLIENT, NymCardClient } from '../nymcard/nymcard.types';

/**
 * Nightly job: compares every non-cancelled card with NymCard and repairs drift
 * (status, balance). Discrepancies are written to the audit log for ops review.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(NYMCARD_CLIENT) private readonly nymcard: NymCardClient,
  ) {}

  async run() {
    let cursor: string | undefined;
    let checked = 0;
    let drift = 0;
    for (;;) {
      const cards = await this.prisma.card.findMany({
        where: { status: { not: 'CANCELLED' } },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (cards.length === 0) break;
      for (const card of cards) {
        checked++;
        try {
          const remote = await this.nymcard.getCard(card.nymcardCardId);
          if (remote.status !== card.status || remote.balanceFils !== card.availableBalanceFils) {
            drift++;
            await this.prisma.card.update({
              where: { id: card.id },
              data: { status: remote.status, availableBalanceFils: remote.balanceFils },
            });
            await this.audit.log({
              actorType: 'SYSTEM',
              action: 'reconciliation.card_drift',
              targetType: 'Card',
              targetId: card.id,
              before: { status: card.status, balance: card.availableBalanceFils },
              after: { status: remote.status, balance: remote.balanceFils },
            });
          }
        } catch (err) {
          this.logger.warn(`Reconciliation failed for card ${card.id}: ${(err as Error).message}`);
        }
      }
      cursor = cards[cards.length - 1]!.id;
    }
    this.logger.log(`Reconciliation done: ${checked} cards checked, ${drift} corrected`);
    return { checked, drift };
  }
}
