/* eslint-disable no-console */
import { config } from 'dotenv';
config({ path: '../../.env' });
config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { addVat } from '@onlinepay/shared';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data in production');
  }

  const bundle = await prisma.bundle.upsert({
    where: { code: 'CARDS_30' },
    update: {},
    create: {
      code: 'CARDS_30',
      nameEn: '30 virtual cards',
      nameAr: '٣٠ بطاقة افتراضية',
      cardQuota: 30,
      priceFils: 3000,
      mode: 'ONE_TIME',
    },
  });

  // ── Demo consumer (KYC approved, one bundle, a few cards) ──
  const user = await prisma.user.upsert({
    where: { email: 'demo@onlinepay.local' },
    update: {},
    create: {
      fullName: 'Demo User',
      email: 'demo@onlinepay.local',
      phone: '+971500000001',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      status: 'ACTIVE',
      termsAcceptedAt: new Date(),
      nymcardHolderId: 'mock-holder-demo',
    },
  });

  await prisma.kycApplication.upsert({
    where: { provider_providerRef: { provider: 'mock', providerRef: 'mock-kyc-demo' } },
    update: {},
    create: {
      userId: user.id,
      provider: 'mock',
      providerRef: 'mock-kyc-demo',
      documentType: 'EMIRATES_ID',
      nationality: 'AE',
      dateOfBirth: new Date('1990-01-01'),
      status: 'APPROVED',
      reviewedAt: new Date(),
    },
  });

  const vat = addVat(bundle.priceFils);
  const purchase = await prisma.purchase.upsert({
    where: { idempotencyKey: 'seed-demo-bundle' },
    update: {},
    create: {
      userId: user.id,
      type: 'BUNDLE',
      bundleId: bundle.id,
      cardQuota: bundle.cardQuota,
      subtotalFils: vat.subtotalFils,
      vatFils: vat.vatFils,
      totalFils: vat.totalFils,
      status: 'PAID',
      gateway: 'mock',
      gatewayPaymentId: 'mock-pay-seed',
      idempotencyKey: 'seed-demo-bundle',
      paidAt: new Date(),
    },
  });

  await prisma.invoice.upsert({
    where: { purchaseId: purchase.id },
    update: {},
    create: {
      number: 'OP-SEED-000001',
      userId: user.id,
      purchaseId: purchase.id,
      sellerTrn: process.env.COMPANY_TRN ?? 'TRN-PLACEHOLDER',
      description: '30 virtual cards bundle',
      subtotalFils: vat.subtotalFils,
      vatRateBps: vat.vatRateBps,
      vatFils: vat.vatFils,
      totalFils: vat.totalFils,
    },
  });

  await prisma.wallet.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      balanceFils: 10000,
      entries: {
        create: {
          type: 'ADJUSTMENT',
          amountFils: 10000,
          balanceAfter: 10000,
          idempotencyKey: 'seed-demo-wallet',
          memo: 'Seed balance',
        },
      },
    },
  });

  const cards = [
    { id: 'mock-card-netflix', label: 'Netflix', last4: '4242', status: 'ACTIVE' as const },
    { id: 'mock-card-amazon', label: 'Amazon', last4: '1881', status: 'FROZEN' as const },
    { id: 'mock-card-trial', label: 'Free trial', last4: '0005', status: 'CANCELLED' as const },
  ];
  for (const c of cards) {
    const card = await prisma.card.upsert({
      where: { nymcardCardId: c.id },
      update: {},
      create: {
        userId: user.id,
        nymcardCardId: c.id,
        label: c.label,
        last4: c.last4,
        expiryMonth: 12,
        expiryYear: 2029,
        status: c.status,
        availableBalanceFils: c.status === 'CANCELLED' ? 0 : 5000,
        cancelledAt: c.status === 'CANCELLED' ? new Date() : null,
      },
    });
    if (c.label === 'Netflix') {
      await prisma.cardTransaction.upsert({
        where: { providerTxnId: 'mock-txn-seed-1' },
        update: {},
        create: {
          cardId: card.id,
          providerTxnId: 'mock-txn-seed-1',
          type: 'SETTLEMENT',
          status: 'SETTLED',
          amountFils: 3999,
          merchantName: 'NETFLIX.COM',
          merchantCountry: 'NL',
          mcc: '4899',
          occurredAt: new Date(),
        },
      });
    }
  }

  // ── Demo admin (password from env, TOTP secret printed once) ──
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@onlinepay.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error('Set SEED_ADMIN_PASSWORD (12+ chars) before seeding');
  }
  const existing = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const totpSecret = authenticator.generateSecret();
    await prisma.adminUser.create({
      data: {
        email: adminEmail,
        name: 'Super Admin',
        passwordHash: await bcrypt.hash(adminPassword, 12),
        totpSecret,
        totpEnabled: true,
        role: 'SUPER_ADMIN',
      },
    });
    console.log('\nAdmin created:', adminEmail);
    console.log('Add this TOTP secret to your authenticator app (shown once):', totpSecret);
    console.log('otpauth URI:', authenticator.keyuri(adminEmail, 'OnlinePay Admin', totpSecret), '\n');
  }

  console.log('Seed complete. Demo login: demo@onlinepay.local (OTP is printed by the API in dev).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
