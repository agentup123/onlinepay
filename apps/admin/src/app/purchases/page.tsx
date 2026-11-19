'use client';

import { aed, dt, useAdminApi } from '@/lib/api';
import { ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Purchases() {
  const { data, error } = useAdminApi<any[]>('/admin/purchases');
  return (
    <div>
      <PageTitle>Purchases</PageTitle>
      <p className="mb-4 text-sm text-slate-600">Refunds are issued from the user's page.</p>
      <ErrorBox error={error} />
      <Table
        head={['User', 'Type', 'Subtotal', 'VAT', 'Total', 'Status', 'Invoice', 'Created']}
        rows={(data ?? []).map((p) => [
          p.user.email,
          p.type,
          aed(p.subtotalFils),
          aed(p.vatFils),
          aed(p.totalFils),
          p.status,
          p.invoice?.number ?? '—',
          dt(p.createdAt),
        ])}
      />
    </div>
  );
}
