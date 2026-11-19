'use client';

import { FormEvent, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { api } from '@/lib/api';
import { ErrorText } from '@/components/ui';

export default function SignupPage() {
  const t = useTranslations('auth');
  const tl = useTranslations('legal');
  const locale = useLocale();
  const router = useRouter();
  const [step, setStep] = useState<'details' | 'verify'>('details');
  const [challenges, setChallenges] = useState<{ emailChallengeId: string; phoneChallengeId: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const start = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ emailChallengeId: string; phoneChallengeId: string }>('/auth/signup', {
        body: {
          fullName: f.get('fullName'),
          email: f.get('email'),
          phone: f.get('phone'),
          locale,
          acceptTerms: f.get('acceptTerms') === 'on',
        },
      });
      setChallenges(res);
      setStep('verify');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!challenges) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/auth/signup/verify', {
        body: { ...challenges, emailCode: f.get('emailCode'), phoneCode: f.get('phoneCode') },
      });
      router.replace('/kyc');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <div className="panel space-y-5">
        {step === 'details' ? (
          <form onSubmit={start} className="space-y-4">
            <h1 className="text-2xl font-bold">{t('signupTitle')}</h1>
            <div>
              <label className="label" htmlFor="fullName">{t('fullName')}</label>
              <input className="input" id="fullName" name="fullName" required minLength={2} autoComplete="name" />
            </div>
            <div>
              <label className="label" htmlFor="email">{t('email')}</label>
              <input className="input" id="email" name="email" type="email" required autoComplete="email" dir="ltr" />
            </div>
            <div>
              <label className="label" htmlFor="phone">{t('phone')}</label>
              <input className="input" id="phone" name="phone" type="tel" required placeholder={t('phoneHint')} autoComplete="tel" dir="ltr" />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acceptTerms" required className="mt-1" />
              <span>
                {t('acceptTerms')} (<Link className="underline" href="/legal/terms">{tl('terms')}</Link>,{' '}
                <Link className="underline" href="/legal/privacy">{tl('privacy')}</Link>)
              </span>
            </label>
            <ErrorText error={error} />
            <button className="btn-primary w-full" disabled={busy}>{t('continue')}</button>
            <Link href="/login" className="block text-center text-sm text-brand-700">{t('haveAccount')}</Link>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <h1 className="text-2xl font-bold">{t('verifyTitle')}</h1>
            <p className="text-slate-600">{t('verifyIntro')}</p>
            <div>
              <label className="label" htmlFor="emailCode">{t('emailCode')}</label>
              <input className="input ltr-nums tracking-widest" id="emailCode" name="emailCode" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" />
            </div>
            <div>
              <label className="label" htmlFor="phoneCode">{t('phoneCode')}</label>
              <input className="input ltr-nums tracking-widest" id="phoneCode" name="phoneCode" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" />
            </div>
            <ErrorText error={error} />
            <button className="btn-primary w-full" disabled={busy}>{t('verify')}</button>
          </form>
        )}
      </div>
    </div>
  );
}
