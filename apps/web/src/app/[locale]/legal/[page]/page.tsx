import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

const PAGES = ['terms', 'privacy', 'fees'] as const;
type Page = (typeof PAGES)[number];

/**
 * PLACEHOLDER legal pages. Every section must be drafted and reviewed by UAE counsel before
 * launch (consumer protection, PDPL, CBUAE stored-value rules, NymCard programme terms).
 */
const OUTLINE: Record<Page, string[]> = {
  terms: [
    'Who we are (programme manager) and who issues the cards (licensed issuer via NymCard)',
    'Eligibility: UAE residents aged 18+, successful identity verification',
    'Bundles: what you buy, card quota, what happens on cancellation',
    'Wallet and card balances, top-ups, limits, refunds and unused balances',
    'Prohibited use (gambling, illegal goods, sanctions) and our right to freeze or close',
    'Disputes and chargebacks; complaints procedure and escalation',
    'Liability, governing law (UAE) and changes to these terms',
  ],
  privacy: [
    'What personal data we collect (account, KYC outcome, transactions) and why',
    'What we never store (card numbers, CVV, ID document images)',
    'Sharing with the card issuer, KYC provider and payment gateway',
    'Retention periods (AML record-keeping) and international transfers',
    'Your rights under the UAE PDPL and how to contact us',
  ],
  fees: [
    '30 virtual cards: 30.00 AED + 5% VAT (31.50 AED), one-time',
    'Wallet top-ups: no OnlinePay fee (gateway fees TBD)',
    'Foreign-currency transactions: issuer FX rate and any FX fee — TBD with NymCard',
    'Card cancellation: free; remaining balance returned to wallet',
  ],
};

export default async function LegalPage({ params }: { params: Promise<{ locale: string; page: string }> }) {
  const { locale, page } = await params;
  if (!PAGES.includes(page as Page)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('legal');

  return (
    <article className="panel mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">{t(page as Page)}</h1>
      <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">{t('reviewNotice')}</p>
      <ul className="list-disc space-y-2 ps-6 text-slate-700" dir="ltr">
        {OUTLINE[page as Page].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </article>
  );
}
