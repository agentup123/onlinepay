import { BadRequestException, Injectable } from '@nestjs/common';
import { LedgerEntryType, Prisma } from '@onlinepay/db';
import { assertFils } from '@onlinepay/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface LedgerInput {
  userId: string;
  amountFils: number; // always positive; direction comes from credit/debit
  type: LedgerEntryType;
  idempotencyKey: string;
  cardId?: string;
  purchaseId?: string;
  memo?: string;
}

/**
 * Stored-value wallet with an append-only ledger. Balance updates are atomic and guarded so
 * the balance can never go negative, and every movement is idempotent by key.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { balanceFils: wallet.balanceFils, currency: wallet.currency, entries };
  }

  credit(input: LedgerInput, tx?: Prisma.TransactionClient) {
    return this.move(input, +1, tx);
  }

  debit(input: LedgerInput, tx?: Prisma.TransactionClient) {
    return this.move(input, -1, tx);
  }

  private async move(input: LedgerInput, direction: 1 | -1, outerTx?: Prisma.TransactionClient) {
    assertFils(input.amountFils);
    if (input.amountFils <= 0) throw new BadRequestException({ code: 'INVALID_AMOUNT' });

    const run = async (tx: Prisma.TransactionClient) => {
      const existing = await tx.walletLedgerEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;

      const wallet = await tx.wallet.upsert({
        where: { userId: input.userId },
        update: {},
        create: { userId: input.userId },
      });

      const delta = direction * input.amountFils;
      const updated = await tx.wallet.updateMany({
        where: {
          id: wallet.id,
          ...(direction < 0 ? { balanceFils: { gte: input.amountFils } } : {}),
        },
        data: { balanceFils: { increment: delta } },
      });
      if (updated.count !== 1)
        throw new BadRequestException({ code: 'INSUFFICIENT_WALLET_BALANCE' });

      const { balanceFils } = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      return tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          type: input.type,
          amountFils: delta,
          balanceAfter: balanceFils,
          idempotencyKey: input.idempotencyKey,
          cardId: input.cardId,
          purchaseId: input.purchaseId,
          memo: input.memo,
        },
      });
    };

    return outerTx ? run(outerTx) : this.prisma.$transaction(run);
  }
}
