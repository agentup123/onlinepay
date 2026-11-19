'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatFils } from '@onlinepay/shared';
import type { CardStatus } from '@/lib/types';
import { ApiError } from '@/lib/api';

export function Money({ fils, className = '' }: { fils: number; className?: string }) {
  const locale = useLocale() as 'en' | 'ar';
  return <span className={`ltr-nums ${className}`}>{formatFils(fils, locale)}</span>;
}

const STATUS_STYLES: Record<CardStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  FROZEN: 'bg-sky-50 text-sky-700 ring-sky-200',
  CANCELLED: 'bg-slate-100 text-slate-500 ring-slate-200',
};

export function StatusBadge({ status }: { status: CardStatus }) {
  const t = useTranslations('card.status');
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STATUS_STYLES[status]}`}>
      {t(status)}
    </span>
  );
}

/** Maps API error codes to translated, user-friendly messages. */
export function ErrorText({ error }: { error: unknown }) {
  const t = useTranslations('errors');
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : 'generic';
  const msg = t.has(code) ? t(code) : t('generic');
  return (
    <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
      {msg}
    </p>
  );
}

export function Spinner() {
  const t = useTranslations('common');
  return <p className="py-10 text-center text-slate-500">{t('loading')}</p>;
}
