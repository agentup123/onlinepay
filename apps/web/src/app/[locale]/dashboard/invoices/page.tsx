'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { useApi } from '@/lib/hooks';
import type { Invoice } from '@/lib/types';
import { Money, Spinner } from '@/components/ui';

export default function InvoicesPage() {
  const t = useTranslations('invoices');
  const locale = useLocale();
  const { data, loading } = useApi<Invoice[]>('/me/invoices');
  if (loading && !data) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <div className="panel">
        {(data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data!.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/dashboard/invoices/${inv.id}`}
                  className="flex justify-between py-3 text-sm hover:bg-slate-50"
                >
                  <span>
                    <span className="ltr-nums font-medium">{inv.number}</span>
                    <span className="block text-xs text-slate-500">
                      {new Date(inv.issuedAt).toLocaleDateString(
                        locale === 'ar' ? 'ar-AE' : 'en-AE',
                      )}
                    </span>
                  </span>
                  <Money fils={inv.totalFils} className="font-semibold" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
