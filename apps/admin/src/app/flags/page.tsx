'use client';

import Link from 'next/link';
import { api, dt, useAdminApi } from '@/lib/api';
import { Btn, ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Flags() {
  const { data, error, reload } = useAdminApi<any[]>('/admin/flags?status=OPEN');
  const update = async (id: string, status: 'DISMISSED' | 'ESCALATED' | 'REVIEWING') => {
    const resolution = window.prompt('Resolution note') ?? undefined;
    await api(`/admin/flags/${id}`, { method: 'PATCH', body: { status, resolution } });
    await reload();
  };
  return (
    <div>
      <PageTitle>Transaction monitoring</PageTitle>
      <p className="mb-4 text-sm text-slate-600">Escalate anything that may need a Suspicious Transaction Report (goAML) to your MLRO.</p>
      <ErrorBox error={error} />
      <Table
        head={['User', 'Rule', 'Details', 'When', '']}
        empty="No open flags."
        rows={(data ?? []).map((f) => [
          <Link key="u" className="text-blue-700 underline" href={`/users/${f.user.id}`}>{f.user.fullName}</Link>,
          f.rule,
          <code key="d" className="text-xs">{JSON.stringify(f.details)}</code>,
          dt(f.createdAt),
          <div key="a" className="flex gap-1">
            <Btn onClick={() => update(f.id, 'REVIEWING')}>Reviewing</Btn>
            <Btn onClick={() => update(f.id, 'DISMISSED')}>Dismiss</Btn>
            <Btn tone="danger" onClick={() => update(f.id, 'ESCALATED')}>Escalate</Btn>
          </div>,
        ])}
      />
    </div>
  );
}
