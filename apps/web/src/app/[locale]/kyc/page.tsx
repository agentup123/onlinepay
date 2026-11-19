'use client';

import { FormEvent, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ErrorText, Spinner } from '@/components/ui';

type KycStatus = 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';

export default function KycPage() {
  const t = useTranslations('kyc');
  const td = useTranslations('dashboard');
  const { data, loading, reload } = useApi<{ status: KycStatus }>('/kyc');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      // In production, launch the KYC provider's capture SDK here and pass its reference.
      // The mock provider accepts any reference.
      const providerCaptureRef = `web-${crypto.randomUUID()}`;
      await api('/kyc', {
        body: {
          documentType: f.get('documentType'),
          nationality: String(f.get('nationality') ?? '').toUpperCase(),
          dateOfBirth: f.get('dateOfBirth'),
          providerCaptureRef,
        },
      });
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  const status = data?.status ?? 'NOT_STARTED';

  return (
    <div className="mx-auto max-w-md">
      <div className="panel space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        {status === 'NOT_STARTED' || status === 'NEEDS_INFO' ? (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-slate-600">{t('intro')}</p>
            {status === 'NEEDS_INFO' && (
              <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
                {t('status.NEEDS_INFO')}
              </p>
            )}
            <div>
              <label className="label" htmlFor="documentType">
                {t('documentType')}
              </label>
              <select
                className="input"
                id="documentType"
                name="documentType"
                defaultValue="EMIRATES_ID"
              >
                <option value="EMIRATES_ID">{t('emiratesId')}</option>
                <option value="PASSPORT">{t('passport')}</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="nationality">
                {t('nationality')}
              </label>
              <input
                className="input uppercase"
                id="nationality"
                name="nationality"
                required
                minLength={2}
                maxLength={2}
                dir="ltr"
              />
            </div>
            <div>
              <label className="label" htmlFor="dateOfBirth">
                {t('dob')}
              </label>
              <input
                className="input"
                id="dateOfBirth"
                name="dateOfBirth"
                type="date"
                required
                dir="ltr"
              />
            </div>
            <p className="text-xs text-slate-500">{t('privacyNote')}</p>
            <ErrorText error={error} />
            <button className="btn-primary w-full" disabled={busy}>
              {t('start')}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <p data-testid="kyc-status">{t(`status.${status}`)}</p>
            {status === 'APPROVED' && (
              <Link href="/dashboard" className="btn-primary w-full">
                {td('title')}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
