'use client';

import { use, useState } from 'react';
import { aed, api, askReason, dt, newIdempotencyKey, useAdminApi } from '@/lib/api';
import { Btn, ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function UserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: u, error, reload } = useAdminApi<any>(`/admin/users/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (label: string, path: string, extra: Record<string, unknown> = {}) => {
    const reason = askReason(label);
    if (!reason) return;
    try {
      await api(path, { body: { reason, ...extra }, idempotencyKey: newIdempotencyKey() });
      setActionError(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  if (!u) return <ErrorBox error={error} />;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <PageTitle>{u.fullName}</PageTitle>
          <p className="text-sm text-slate-600">
            {u.email} · {u.phone} · {u.status} · joined {dt(u.createdAt)}
          </p>
          <p className="text-sm text-slate-600">Wallet: {aed(u.wallet?.balanceFils ?? 0)}</p>
        </div>
        <div className="flex gap-2">
          {u.status === 'ACTIVE' ? (
            <Btn tone="danger" onClick={() => act('suspend user', `/admin/users/${id}/suspend`)}>
              Suspend
            </Btn>
          ) : (
            <Btn onClick={() => act('reactivate user', `/admin/users/${id}/reactivate`)}>
              Reactivate
            </Btn>
          )}
        </div>
      </div>
      <ErrorBox error={actionError} />

      <section>
        <h2 className="mb-2 font-semibold">KYC</h2>
        <Table
          head={['Status', 'Document', 'Nationality', 'Provider ref', 'Submitted']}
          rows={u.kyc.map((k: any) => [
            k.status,
            k.documentType,
            k.nationality,
            k.providerRef,
            dt(k.createdAt),
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Cards</h2>
        <Table
          head={['Label', 'Last 4', 'Status', 'Balance', 'Created', '']}
          rows={u.cards.map((c: any) => [
            c.label,
            c.last4,
            c.status,
            aed(c.availableBalanceFils),
            dt(c.createdAt),
            c.status === 'CANCELLED' ? (
              ''
            ) : (
              <div key="a" className="flex gap-1">
                {c.status === 'ACTIVE' ? (
                  <Btn onClick={() => act('freeze card', `/admin/cards/${c.id}/freeze`)}>
                    Freeze
                  </Btn>
                ) : (
                  <Btn onClick={() => act('unfreeze card', `/admin/cards/${c.id}/unfreeze`)}>
                    Unfreeze
                  </Btn>
                )}
                <Btn
                  tone="danger"
                  onClick={() => act('cancel card', `/admin/cards/${c.id}/cancel`)}
                >
                  Cancel
                </Btn>
              </div>
            ),
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Purchases</h2>
        <Table
          head={['Type', 'Total', 'Status', 'Invoice', 'Paid', '']}
          rows={u.purchases.map((p: any) => [
            p.type,
            aed(p.totalFils),
            p.status,
            p.invoice?.number ?? '—',
            p.paidAt ? dt(p.paidAt) : '—',
            p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED' ? (
              <Btn
                key="r"
                tone="danger"
                onClick={() => {
                  const amount = window.prompt(
                    'Refund amount in fils (e.g. 3150 = 31.50 AED)',
                    String(p.totalFils),
                  );
                  if (amount)
                    void act('refund purchase', `/admin/purchases/${p.id}/refund`, {
                      amountFils: Number(amount),
                    });
                }}
              >
                Refund
              </Btn>
            ) : (
              ''
            ),
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Monitoring flags</h2>
        <Table
          head={['Rule', 'Status', 'Details', 'When']}
          rows={u.flags.map((f: any) => [
            f.rule,
            f.status,
            JSON.stringify(f.details),
            dt(f.createdAt),
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Wallet ledger</h2>
        <Table
          head={['Type', 'Amount', 'Balance after', 'Memo', 'When']}
          rows={(u.wallet?.entries ?? []).map((e: any) => [
            e.type,
            aed(e.amountFils),
            aed(e.balanceAfter),
            e.memo ?? '',
            dt(e.createdAt),
          ])}
        />
      </section>
    </div>
  );
}
