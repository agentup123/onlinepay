'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import type { Card } from '@/lib/types';
import { Money, StatusBadge } from './ui';

export function CardTile({ card }: { card: Card }) {
  const t = useTranslations('card');
  const muted = card.status !== 'ACTIVE';
  return (
    <Link
      href={`/dashboard/cards/${card.id}`}
      className={`block rounded-2xl p-5 text-white shadow-md transition hover:-translate-y-0.5 hover:shadow-lg ${
        muted ? 'bg-gradient-to-br from-slate-500 to-slate-700' : 'bg-gradient-to-br from-brand-600 to-brand-900'
      }`}
      data-testid="card-tile"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-lg font-semibold">{card.label}</span>
        <StatusBadge status={card.status} />
      </div>
      <p className="ltr-nums mt-6 font-mono text-lg tracking-widest">•••• •••• •••• {card.last4}</p>
      <div className="mt-4 flex items-end justify-between text-sm opacity-90">
        <span>
          {t('expires')}{' '}
          <span className="ltr-nums">
            {String(card.expiryMonth).padStart(2, '0')}/{String(card.expiryYear).slice(-2)}
          </span>
        </span>
        <span>
          {t('balance')} <Money fils={card.availableBalanceFils} className="font-semibold" />
        </span>
      </div>
    </Link>
  );
}
