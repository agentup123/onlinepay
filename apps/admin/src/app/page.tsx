'use client';

import { aed, useAdminApi } from '@/lib/api';
import { ErrorBox, PageTitle } from '@/components/Table';

interface Stats {
  users: number;
  pendingKyc: number;
  activeCards: number;
  openFlags: number;
  paidPurchases: number;
  revenueFils: number;
  failedWebhooks: number;
}

export default function Overview() {
  const { data, error } = useAdminApi<Stats>('/admin/stats');
  const tiles: [string, string | number][] = data
    ? [
        ['Active users', data.users],
        ['KYC pending', data.pendingKyc],
        ['Active cards', data.activeCards],
        ['Open flags', data.openFlags],
        ['Paid purchases', data.paidPurchases],
        ['Gross receipts (incl. VAT)', aed(data.revenueFils)],
        ['Stuck webhooks', data.failedWebhooks],
      ]
    : [];
  return (
    <div>
      <PageTitle>Overview</PageTitle>
      <ErrorBox error={error} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-white p-4 shadow-sm">
            <p className="text-xs uppercase text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-bold">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
