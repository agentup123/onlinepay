'use client';

import { FormEvent, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { parseAedToFils } from '@onlinepay/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { Wallet } from '@/lib/types';
import { ErrorText, Money, Spinner } from '@/components/ui';

export default function WalletPage() {
  const t = useTranslations('wallet');
  const locale = useLocale();
  const wallet = useApi<Wallet>('/wallet');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const topUp = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const amount = String(new FormData(e.currentTarget).get('amount') ?? '');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirectUrl: string }>('/payments/wallet/checkout', {
        body: { amountFils: parseAedToFils(amount) },
        idempotencyKey: newIdempotencyKey(),
      });
      window.location.assign(res.redirectUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (wallet.loading && !wallet.data) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="panel">
          <p className="text-sm text-slate-500">{t('balance')}</p>
          <p className="mt-2 text-3xl font-bold">
            <Money fils={wallet.data?.balanceFils ?? 0} />
          </p>
        </div>
        <form onSubmit={topUp} className="panel space-y-3">
          <label className="label" htmlFor="amount">
            {t('amount')}
          </label>
          <input
            className="input ltr-nums"
            id="amount"
            name="amount"
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            required
          />
          <ErrorText error={error} />
          <button className="btn-primary w-full" disabled={busy}>
            {t('topUp')}
          </button>
        </form>
      </div>
      <div className="panel">
        <h2 className="mb-3 font-semibold">{t('history')}</h2>
        {(wallet.data?.entries ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {wallet.data!.entries.map((e) => (
              <li key={e.id} className="flex justify-between py-3 text-sm">
                <div>
                  <p className="font-medium">
                    {t.has(`types.${e.type}`) ? t(`types.${e.type}`) : e.type}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(e.createdAt).toLocaleString(locale === 'ar' ? 'ar-AE' : 'en-AE')}
                  </p>
                </div>
                <Money
                  fils={e.amountFils}
                  className={e.amountFils < 0 ? 'text-red-700' : 'text-emerald-700'}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
