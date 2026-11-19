'use client';

import { FormEvent, use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { parseAedToFils } from '@onlinepay/shared';
import { api, newIdempotencyKey } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { Card, CardTransaction } from '@/lib/types';
import { CardTile } from '@/components/CardTile';
import { ErrorText, Money, Spinner } from '@/components/ui';

const IS_DEV = process.env.NODE_ENV !== 'production';

export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('card');
  const tc = useTranslations('common');
  const locale = useLocale();
  const card = useApi<Card>(`/cards/${id}`);
  const txns = useApi<CardTransaction[]>(`/cards/${id}/transactions`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [secureUrl, setSecureUrl] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([card.reload(), txns.reload()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (card.loading && !card.data) return <Spinner />;
  if (!card.data) return <ErrorText error={card.error} />;
  const c = card.data;
  const active = c.status === 'ACTIVE';
  const cancelled = c.status === 'CANCELLED';

  const fund = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const amount = String(new FormData(e.currentTarget).get('amount') ?? '');
    void run(() =>
      api(`/cards/${id}/fund`, {
        body: { amountFils: parseAedToFils(amount) },
        idempotencyKey: newIdempotencyKey(),
      }),
    );
  };

  const setLimit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const amount = String(new FormData(e.currentTarget).get('limit') ?? '').trim();
    void run(() =>
      api(`/cards/${id}/limit`, {
        body: { spendingLimitFils: amount ? parseAedToFils(amount) : null },
      }),
    );
  };

  const reveal = () =>
    run(async () => {
      if (secureUrl) return setSecureUrl(null);
      const s = await api<{ url: string }>(`/cards/${id}/reveal`, { body: {} });
      setSecureUrl(s.url);
      // Issuer sessions are short-lived; hide automatically.
      setTimeout(() => setSecureUrl(null), 60_000);
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <CardTile card={c} />
        {active && (
          <div className="panel space-y-3">
            <button className="btn-secondary w-full" onClick={reveal} disabled={busy}>
              {secureUrl ? t('hide') : t('reveal')}
            </button>
            {secureUrl && (
              <iframe
                src={secureUrl}
                title={t('reveal')}
                className="h-48 w-full rounded-xl border"
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
              />
            )}
            <p className="text-xs text-slate-500">{t('revealNote')}</p>
          </div>
        )}
        {!cancelled && (
          <div className="panel flex flex-wrap gap-2">
            {active ? (
              <button
                className="btn-secondary flex-1"
                disabled={busy}
                onClick={() => run(() => api(`/cards/${id}/freeze`, { body: {} }))}
                data-testid="freeze"
              >
                {t('freeze')}
              </button>
            ) : (
              <button
                className="btn-secondary flex-1"
                disabled={busy}
                onClick={() => run(() => api(`/cards/${id}/unfreeze`, { body: {} }))}
                data-testid="unfreeze"
              >
                {t('unfreeze')}
              </button>
            )}
            <button
              className="btn-danger flex-1"
              disabled={busy}
              data-testid="cancel-card"
              onClick={() => {
                if (window.confirm(t('cancelConfirm'))) {
                  void run(() =>
                    api(`/cards/${id}/cancel`, { body: {}, idempotencyKey: newIdempotencyKey() }),
                  );
                }
              }}
            >
              {t('cancel')}
            </button>
          </div>
        )}
        <ErrorText error={error} />
      </div>

      <div className="space-y-4">
        {active && (
          <div className="grid gap-4 sm:grid-cols-2">
            <form onSubmit={fund} className="panel space-y-3">
              <h2 className="font-semibold">{t('fund')}</h2>
              <label className="label" htmlFor="amount">
                {t('fundAmount')}
              </label>
              <input
                className="input ltr-nums"
                id="amount"
                name="amount"
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                required
              />
              <button className="btn-primary w-full" disabled={busy}>
                {t('fund')}
              </button>
            </form>
            <form onSubmit={setLimit} className="panel space-y-3">
              <h2 className="font-semibold">{t('limit')}</h2>
              <p className="text-sm text-slate-600">
                {c.spendingLimitFils ? <Money fils={c.spendingLimitFils} /> : t('noLimit')}
              </p>
              <label className="label" htmlFor="limit">
                {t('limitAmount')}
              </label>
              <input
                className="input ltr-nums"
                id="limit"
                name="limit"
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
              />
              <button className="btn-secondary w-full" disabled={busy}>
                {tc('save')}
              </button>
            </form>
          </div>
        )}

        <div className="panel">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">{t('transactions')}</h2>
            {IS_DEV && active && (
              <button
                className="text-xs text-brand-700 underline"
                onClick={() =>
                  run(() =>
                    api('/dev/simulate-transaction', {
                      body: { cardId: id, amountFils: 1999, merchantName: 'DEMO STORE' },
                    }),
                  )
                }
              >
                {t('simulate')}
              </button>
            )}
          </div>
          {(txns.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">{t('noTransactions')}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {txns.data!.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium">{x.merchantName ?? '—'}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(x.occurredAt).toLocaleString(locale === 'ar' ? 'ar-AE' : 'en-AE')} ·{' '}
                      {t(`txnStatus.${x.status}`)}
                      {x.declineReason ? ` · ${x.declineReason}` : ''}
                    </p>
                  </div>
                  <Money
                    fils={x.amountFils}
                    className={
                      x.status === 'DECLINED' || x.status === 'REVERSED'
                        ? 'text-slate-400 line-through'
                        : 'font-semibold'
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
