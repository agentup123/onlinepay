'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, dt, useAdminApi } from '@/lib/api';
import { Btn, ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function KycQueue() {
  const { data, error, reload } = useAdminApi<any[]>('/admin/kyc?status=PENDING');
  const [actionError, setActionError] = useState<string | null>(null);

  const decide = async (id: string, decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO') => {
    const note = decision === 'APPROVED' ? undefined : window.prompt('Note for the record') ?? undefined;
    try {
      await api(`/admin/kyc/${id}/decision`, { body: { decision, note } });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <div>
      <PageTitle>KYC queue</PageTitle>
      <p className="mb-4 text-sm text-slate-600">Review documents in the KYC provider's console, then record the decision here.</p>
      <ErrorBox error={error ?? actionError} />
      <Table
        head={['User', 'Document', 'Nationality', 'Provider ref', 'Submitted', '']}
        empty="No applications waiting."
        rows={(data ?? []).map((k) => [
          <Link key="u" className="text-blue-700 underline" href={`/users/${k.user.id}`}>{k.user.fullName}</Link>,
          k.documentType,
          k.nationality,
          k.providerRef,
          dt(k.createdAt),
          <div key="a" className="flex gap-1">
            <Btn onClick={() => decide(k.id, 'APPROVED')}>Approve</Btn>
            <Btn onClick={() => decide(k.id, 'NEEDS_INFO')}>Needs info</Btn>
            <Btn tone="danger" onClick={() => decide(k.id, 'REJECTED')}>Reject</Btn>
          </div>,
        ])}
      />
    </div>
  );
}
