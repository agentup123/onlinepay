'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { api } from '@/lib/api';

type Outcome = 'success' | 'processing' | 'cancelled' | 'failed';

/**
 * The gateway redirect is only a hint — the purchase is confirmed by the webhook. We poll the
 * purchase status until the worker marks it PAID.
 */
export default function CheckoutResultPage() {
  return (
    <Suspense>
      <Result />
    </Suspense>
  );
}

function Result() {
  const t = useTranslations('checkout');
  const params = useSearchParams();
  const purchaseId = params.get('purchase');
  const redirectStatus = params.get('status');
  const [outcome, setOutcome] = useState<Outcome>(redirectStatus === 'success' ? 'processing' : redirectStatus === 'cancelled' ? 'cancelled' : 'failed');

  useEffect(() => {
    if (outcome !== 'processing' || !purchaseId) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const p = await api<{ status: string }>(`/payments/${purchaseId}`);
        if (p.status === 'PAID') setOutcome('success');
        else if (p.status === 'FAILED') setOutcome('failed');
      } catch {
        /* keep polling */
      }
      if (tries > 30) clearInterval(timer);
    }, 1500);
    return () => clearInterval(timer);
  }, [outcome, purchaseId]);

  return (
    <div className="mx-auto max-w-md">
      <div className="panel space-y-4 text-center">
        <p className="text-lg font-semibold" data-testid="checkout-result">{t(`result.${outcome}`)}</p>
        <Link href="/dashboard" className="btn-primary">{t('gotoDashboard')}</Link>
      </div>
    </div>
  );
}
