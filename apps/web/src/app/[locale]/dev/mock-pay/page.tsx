'use client';

import { Suspense, useState } from 'react';
import { notFound, useSearchParams } from 'next/navigation';
import { formatFils } from '@onlinepay/shared';
import { api } from '@/lib/api';

/** DEV ONLY: stands in for the gateway's hosted payment page when PAYMENT_GATEWAY=mock. */
export default function MockPayPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense>
      <MockPay />
    </Suspense>
  );
}

function MockPay() {
  const params = useSearchParams();
  const sessionId = params.get('session') ?? '';
  const amountFils = Number(params.get('amount') ?? 0);
  const [busy, setBusy] = useState(false);

  const finish = async (outcome: 'success' | 'failure') => {
    setBusy(true);
    await api('/webhooks/payments/mock/complete', { body: { sessionId, outcome, amountFils } });
    window.location.assign(
      (outcome === 'success' ? params.get('success') : params.get('cancel')) ?? '/',
    );
  };

  return (
    <div className="mx-auto max-w-sm" dir="ltr">
      <div className="panel space-y-4 border-dashed">
        <p className="text-xs font-bold uppercase text-amber-700">
          Mock payment gateway — development only
        </p>
        <p className="text-3xl font-bold">{formatFils(amountFils)}</p>
        <p className="break-all text-xs text-slate-500">{sessionId}</p>
        <button
          className="btn-primary w-full"
          disabled={busy}
          onClick={() => finish('success')}
          data-testid="mock-pay-success"
        >
          Pay (simulate success)
        </button>
        <button className="btn-secondary w-full" disabled={busy} onClick={() => finish('failure')}>
          Cancel (simulate failure)
        </button>
      </div>
    </div>
  );
}
