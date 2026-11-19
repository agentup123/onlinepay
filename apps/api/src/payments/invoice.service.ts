import { Injectable } from '@nestjs/common';
import type { Prisma, Purchase } from '@onlinepay/db';
import { env } from '../config/env';

/** Issues sequential, per-year VAT invoices: OP-2026-000001. */
@Injectable()
export class InvoiceService {
  async issueForPurchase(tx: Prisma.TransactionClient, purchase: Purchase, description: string) {
    const existing = await tx.invoice.findUnique({ where: { purchaseId: purchase.id } });
    if (existing) return existing;

    const year = new Date().getFullYear();
    const counter = await tx.invoiceCounter.upsert({
      where: { year },
      update: { value: { increment: 1 } },
      create: { year, value: 1 },
    });
    const number = `OP-${year}-${String(counter.value).padStart(6, '0')}`;

    return tx.invoice.create({
      data: {
        number,
        userId: purchase.userId,
        purchaseId: purchase.id,
        sellerTrn: env.COMPANY_TRN,
        description,
        subtotalFils: purchase.subtotalFils,
        vatRateBps: env.VAT_RATE_BPS,
        vatFils: purchase.vatFils,
        totalFils: purchase.totalFils,
      },
    });
  }
}
