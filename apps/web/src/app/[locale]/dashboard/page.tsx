'use client';

import { FormEvent, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { Card, Quota, Wallet } from '@/lib/types';
import { CardTile } from '@/components/CardTile';
import { ErrorText, Money, Spinner } from '@/components/ui';

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const cards = useApi<{ quota: Quota; cards: Card[] }>('/cards');
  const wallet = useApi<Wallet>('/wallet');
  const kyc = useApi<{ status: string }>('/kyc');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const label = String(new FormData(form).get('label') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api('/cards', { body: { label }, idempotencyKey: newIdempotencyKey() });
      form.reset();
      await cards.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (cards.loading && !cards.data) return <Spinner />;
  const quota = cards.data?.quota ?? { purchased: 0, used: 0, remaining: 0 };
  const list = cards.data?.cards ?? [];
  const visible = showCancelled ? list : list.filter((c) => c.status !== 'CANCELLED');
  const kycApproved = kyc.data?.status === 'APPROVED';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-slate-600" data-testid="quota">
            {t('remaining', { remaining: quota.remaining, purchased: quota.purchased })}
          </p>
        </div>
        <Link href="/dashboard/wallet" className="panel !p-3 text-sm">
          {t('walletBalance')}: <Money fils={wallet.data?.balanceFils ?? 0} className="font-semibold" />
        </Link>
      </div>

      {kyc.data && !kycApproved && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-amber-50 p-4 text-amber-900">
          <span>{t('kycRequired')}</span>
          <Link className="btn-primary" href="/kyc">{t('verifyNow')}</Link>
        </div>
      )}

      {kycApproved && quota.remaining === 0 && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-brand-50 p-4">
          <span>{quota.purchased > 0 ? t('bundleNeeded') : ''}</span>
          <Link className="btn-primary" href="/checkout" data-testid="buy-bundle">{t('buyBundle')}</Link>
        </div>
      )}

      {kycApproved && quota.remaining > 0 && (
        <form onSubmit={create} className="panel flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="label" htmlFor="label">{t('cardLabel')}</label>
            <input className="input" id="label" name="label" required maxLength={40} placeholder={t('cardLabelPlaceholder')} />
          </div>
          <button className="btn-primary" disabled={busy} data-testid="create-card">{t('createCard')}</button>
        </form>
      )}
      <ErrorText error={error} />

      {visible.length === 0 ? (
        <p className="py-8 text-center text-slate-500">{t('noCards')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <CardTile key={c.id} card={c} />
          ))}
        </div>
      )}

      {list.some((c) => c.status === 'CANCELLED') && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
          {t('showCancelled')}
        </label>
      )}
    </div>
  );
}
