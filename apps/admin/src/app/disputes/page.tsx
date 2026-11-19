'use client';

import { api, dt, useAdminApi } from '@/lib/api';
import { ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUSES = ['INVESTIGATING', 'RESOLVED_CUSTOMER', 'RESOLVED_MERCHANT', 'CLOSED'];

export default function Disputes() {
  const { data, error, reload } = useAdminApi<any[]>('/admin/disputes');
  const setStatus = async (id: string, status: string) => {
    const notes = window.prompt('Notes') ?? undefined;
    await api(`/admin/disputes/${id}`, { method: 'PATCH', body: { status, notes } });
    await reload();
  };
  return (
    <div>
      <PageTitle>Disputes</PageTitle>
      <ErrorBox error={error} />
      <Table
        head={['User', 'Transaction', 'Reason', 'Status', 'Opened', '']}
        empty="No disputes."
        rows={(data ?? []).map((d) => [
          d.user.email,
          <code key="t" className="text-xs">
            {d.transactionId}
          </code>,
          d.reason,
          d.status,
          dt(d.createdAt),
          <select
            key="s"
            className="rounded border text-xs"
            value=""
            onChange={(e) => e.target.value && setStatus(d.id, e.target.value)}
          >
            <option value="">Set status…</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>,
        ])}
      />
    </div>
  );
}
