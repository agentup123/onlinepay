'use client';

import { use } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useApi } from '@/lib/hooks';
import type { Invoice } from '@/lib/types';
import { Money, Spinner } from '@/components/ui';

/** Printable UAE tax invoice. "Print / save as PDF" uses the browser's PDF export. */
export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('invoices');
  const tc = useTranslations('common');
  const locale = useLocale();
  const { data: inv, loading } = useApi<Invoice>(`/me/invoices/${id}`);
  if (loading && !inv) return <Spinner />;
  if (!inv) return null;

  const row = (label: string, value: React.ReactNode, strong = false) => (
    <div
      className={`flex justify-between py-2 ${strong ? 'border-t border-slate-300 font-bold' : ''}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="panel space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t('taxInvoice')}</h1>
            <p className="text-sm text-slate-500">
              {t('number')}: <span className="ltr-nums">{inv.number}</span>
            </p>
            <p className="text-sm text-slate-500">
              {t('date')}:{' '}
              {new Date(inv.issuedAt).toLocaleDateString(locale === 'ar' ? 'ar-AE' : 'en-AE')}
            </p>
          </div>
          <p className="text-lg font-bold text-brand-700">{tc('appName')}</p>
        </div>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-semibold">{t('seller')}</p>
            <p>OnlinePay</p>
            <p>
              {t('trn')}: <span className="ltr-nums">{inv.sellerTrn}</span>
            </p>
          </div>
          <div>
            <p className="font-semibold">{t('buyer')}</p>
            <p>{inv.user?.fullName}</p>
            <p className="ltr-nums">{inv.user?.email}</p>
          </div>
        </div>
        <div className="text-sm">
          {row(t('description'), inv.description)}
          {row(t('subtotal'), <Money fils={inv.subtotalFils} />)}
          {row(t('vat', { rate: inv.vatRateBps / 100 }), <Money fils={inv.vatFils} />)}
          {row(t('total'), <Money fils={inv.totalFils} />, true)}
        </div>
      </div>
      <button className="btn-secondary no-print" onClick={() => window.print()}>
        {t('print')}
      </button>
    </div>
  );
}
