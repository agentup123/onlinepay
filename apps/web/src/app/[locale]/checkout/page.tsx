'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { addVat } from '@onlinepay/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { ErrorText, Money } from '@/components/ui';

const BUNDLE_PRICE_FILS = 3000;

export default function CheckoutPage() {
  const t = useTranslations('checkout');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // One key per page view: double-clicks and retries reuse the same purchase.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const vat = addVat(BUNDLE_PRICE_FILS);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirectUrl: string }>('/payments/bundle/checkout', {
        body: { bundleCode: 'CARDS_30' },
        idempotencyKey,
      });
      window.location.assign(res.redirectUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <div className="panel space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <div className="text-sm">
          <div className="flex justify-between py-2">
            <span>{t('subtotal')}</span>
            <Money fils={vat.subtotalFils} />
          </div>
          <div className="flex justify-between py-2">
            <span>{t('vat')}</span>
            <Money fils={vat.vatFils} />
          </div>
          <div className="flex justify-between border-t py-2 text-base font-bold">
            <span>{t('total')}</span>
            <Money fils={vat.totalFils} />
          </div>
        </div>
        <p className="text-xs text-slate-500">{t('methods')}</p>
        <ErrorText error={error} />
        <button className="btn-primary w-full" onClick={pay} disabled={busy} data-testid="pay">
          {t('pay')}
        </button>
      </div>
    </div>
  );
}
