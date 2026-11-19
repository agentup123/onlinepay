'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, dt, useAdminApi } from '@/lib/api';
import { Btn, ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function KycQueue() {
  const { data, error, reload } = useAdminApi<any[]>('/admin/kyc?status=PENDING');
  const [actionError, setActionError] = useState<string | null>(null);

  const decide = async (
    k: { id: string; screeningStatus: string | null },
    decision: 'APPROVED' | 'REJECTED' | 'NEEDS_INFO',
  ) => {
    const id = k.id;
    // Approving over a screening hit records a false-positive disposition, which needs a note.
    const needsNote = decision !== 'APPROVED' || k.screeningStatus === 'POTENTIAL_MATCH';
    const note = needsNote
      ? (window.prompt(
          k.screeningStatus === 'POTENTIAL_MATCH' && decision === 'APPROVED'
            ? 'Screening found a potential match. Explain why it is a false positive (min 10 characters):'
            : 'Note for the record',
        ) ?? undefined)
      : undefined;
    if (needsNote && !note) return;
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
      <p className="mb-4 text-sm text-slate-600">
        Review documents in the KYC provider's console and any sanctions/PEP case in the screening
        provider's console, then record the decision here.
      </p>
      <ErrorBox error={error ?? actionError} />
      <Table
        head={['User', 'Document', 'Nationality', 'Screening', 'Provider ref', 'Submitted', '']}
        empty="No applications waiting."
        rows={(data ?? []).map((k) => [
          <Link key="u" className="text-blue-700 underline" href={`/users/${k.user.id}`}>
            {k.user.fullName}
          </Link>,
          k.documentType,
          k.nationality,
          <span
            key="s"
            className={
              k.screeningStatus === 'CLEAR' ? 'text-green-700' : 'font-semibold text-red-700'
            }
            title={k.screeningSummary ?? k.reviewNote ?? ''}
          >
            {k.screeningStatus ?? 'not screened'}
            {k.screeningRef ? ` (${k.screeningRef})` : ''}
          </span>,
          k.providerRef,
          dt(k.createdAt),
          <div key="a" className="flex gap-1">
            <Btn onClick={() => decide(k, 'APPROVED')}>Approve</Btn>
            <Btn onClick={() => decide(k, 'NEEDS_INFO')}>Needs info</Btn>
            <Btn tone="danger" onClick={() => decide(k, 'REJECTED')}>
              Reject
            </Btn>
          </div>,
        ])}
      />
    </div>
  );
}
