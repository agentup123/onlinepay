'use client';

import { FormEvent, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { api } from '@/lib/api';
import { ErrorText } from '@/components/ui';

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const start = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ challengeId: string }>('/auth/login', {
        body: { email: f.get('email') },
      });
      setChallengeId(res.challengeId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login/verify', { body: { challengeId, code: f.get('code') } });
      router.replace('/dashboard');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <div className="panel space-y-4">
        <h1 className="text-2xl font-bold">{t('loginTitle')}</h1>
        {!challengeId ? (
          <form onSubmit={start} className="space-y-4">
            <p className="text-slate-600">{t('loginIntro')}</p>
            <div>
              <label className="label" htmlFor="email">
                {t('email')}
              </label>
              <input
                className="input"
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                dir="ltr"
              />
            </div>
            <ErrorText error={error} />
            <button className="btn-primary w-full" disabled={busy}>
              {t('sendCode')}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <div>
              <label className="label" htmlFor="code">
                {t('loginCode')}
              </label>
              <input
                className="input ltr-nums tracking-widest"
                id="code"
                name="code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                autoComplete="one-time-code"
                autoFocus
              />
            </div>
            <ErrorText error={error} />
            <button className="btn-primary w-full" disabled={busy}>
              {t('verify')}
            </button>
          </form>
        )}
        <Link href="/signup" className="block text-center text-sm text-brand-700">
          {t('noAccount')}
        </Link>
      </div>
    </div>
  );
}
