'use client';

import { useLocale, useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { Notification } from '@/lib/types';
import { Spinner } from '@/components/ui';

export default function NotificationsPage() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const { data, loading, reload } = useApi<Notification[]>('/me/notifications');
  if (loading && !data) return <Spinner />;
  const ar = locale === 'ar';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <button className="btn-secondary" onClick={async () => { await api('/me/notifications/read', { body: {} }); await reload(); }}>
          {t('markRead')}
        </button>
      </div>
      <div className="panel">
        {(data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data!.map((n) => (
              <li key={n.id} className={`py-3 ${n.readAt ? 'opacity-60' : ''}`}>
                <p className="font-medium">{ar ? n.titleAr : n.titleEn}</p>
                <p className="text-sm text-slate-600">{ar ? n.bodyAr : n.bodyEn}</p>
                <p className="text-xs text-slate-400">{new Date(n.createdAt).toLocaleString(ar ? 'ar-AE' : 'en-AE')}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
