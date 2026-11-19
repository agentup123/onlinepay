import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { NYMCARD_CLIENT, NymCardClient } from '../nymcard/nymcard.types';

/**
 * Nightly job.
 *
 * 1. Cards: compares every non-cancelled card with NymCard and repairs status/balance drift.
 *    Cards with an operation in flight are skipped (the resume job owns them). A card the
 *    issuer cancelled while it still held money is flagged for ops — we cannot sweep it.
 * 2. Wallets: checks that every cached wallet balance equals the sum of its ledger. Drift is
 *    never auto-corrected (that would hide a bug); it is audited for investigation.
 *
 * Discrepancies are written to the audit log for ops review. Issuer-side settlement reports
 * (loads/unloads vs our ledger) need NymCard's reporting API — see docs/NYMCARD_INTEGRATION.md.
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
    const cards = await this.reconcileCards();
    const wallets = await this.reconcileWallets();
    this.logger.log(`Reconciliation done: ${JSON.stringify({ cards, wallets })}`);
    return { cards, wallets };
  }

  private async reconcileCards() {
    let cursor: string | undefined;
    let checked = 0;
    let drift = 0;
    for (;;) {
      const cards = await this.prisma.card.findMany({
        where: { status: { not: 'CANCELLED' } },
        orderBy: { id: 'asc' },
        take: 200,
        include: {
          cancellation: true,
          fundings: { where: { status: { in: ['PENDING', 'UNKNOWN'] } }, take: 1 },
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (cards.length === 0) break;
      for (const card of cards) {
        checked++;
        if (card.cancellation || card.fundings.length > 0) continue;
        try {
          const startedAt = new Date();
          const remote = await this.nymcard.getCard(card.nymcardCardId);
          if (remote.status === card.status && remote.balanceFils === card.availableBalanceFils) {
            continue;
          }
          drift++;
          const cancelledRemotely = remote.status === 'CANCELLED';
          await this.prisma.card.updateMany({
            // Don't overwrite a change that happened while we were asking the issuer.
            where: { id: card.id, updatedAt: card.updatedAt },
            data: {
              status: remote.status,
              availableBalanceFils: remote.balanceFils,
              balanceAsOf: startedAt,
              ...(remote.status !== card.status
                ? {
                    statusChangedAt: startedAt,
                    frozenBy: remote.status === 'FROZEN' ? card.frozenBy : null,
                  }
                : {}),
              ...(cancelledRemotely ? { cancelledAt: startedAt } : {}),
            },
          });
          if (cancelledRemotely && remote.balanceFils > 0) {
            await this.prisma.suspiciousActivityFlag.create({
              data: {
                userId: card.userId,
                cardId: card.id,
                rule: 'ISSUER_CANCELLED_WITH_BALANCE',
                details: { balanceFils: remote.balanceFils, source: 'reconciliation' },
              },
            });
          }
          await this.audit.log({
            actorType: 'SYSTEM',
            action: 'reconciliation.card_drift',
            targetType: 'Card',
            targetId: card.id,
            before: { status: card.status, balance: card.availableBalanceFils },
            after: { status: remote.status, balance: remote.balanceFils },
          });
        } catch (err) {
          this.logger.warn(`Reconciliation failed for card ${card.id}: ${(err as Error).message}`);
        }
      }
      cursor = cards[cards.length - 1]!.id;
    }
    return { checked, drift };
  }

  private async reconcileWallets() {
    const sums = await this.prisma.walletLedgerEntry.groupBy({
      by: ['walletId'],
      _sum: { amountFils: true },
    });
    const ledgerByWallet = new Map(sums.map((s) => [s.walletId, s._sum.amountFils ?? 0]));
    const wallets = await this.prisma.wallet.findMany({
      select: { id: true, userId: true, balanceFils: true },
    });
    let drift = 0;
    for (const w of wallets) {
      const ledger = ledgerByWallet.get(w.id) ?? 0;
      if (ledger === w.balanceFils) continue;
      drift++;
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'reconciliation.wallet_drift',
        targetType: 'Wallet',
        targetId: w.id,
        metadata: { userId: w.userId, cachedBalanceFils: w.balanceFils, ledgerSumFils: ledger },
      });
    }
    return { checked: wallets.length, drift };
  }
}
