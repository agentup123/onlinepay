import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { use } from 'react';
import { addVat, formatFils } from '@onlinepay/shared';
import { Link } from '@/i18n/routing';

export default function Landing({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations('landing');
  const total = formatFils(addVat(3000).totalFils, locale as 'en' | 'ar');

  return (
    <div className="space-y-16">
      <section className="grid items-center gap-10 sm:grid-cols-2">
        <div className="space-y-5">
          <h1 className="text-3xl font-extrabold leading-tight sm:text-5xl">{t('heroTitle')}</h1>
          <p className="text-lg text-slate-600">{t('heroSubtitle')}</p>
          <Link href="/signup" className="btn-primary px-6 py-3 text-base">
            {t('cta')}
          </Link>
        </div>
        <div className="relative mx-auto h-56 w-full max-w-sm" aria-hidden>
          <div className="absolute inset-x-6 top-0 h-44 rotate-[-6deg] rounded-2xl bg-gradient-to-br from-slate-500 to-slate-700 shadow-lg" />
          <div className="absolute inset-x-0 top-8 h-44 rounded-2xl bg-gradient-to-br from-brand-600 to-brand-900 p-5 text-white shadow-xl">
            <p className="text-lg font-semibold">Netflix</p>
            <p className="ltr-nums mt-10 font-mono tracking-widest">•••• •••• •••• 4242</p>
          </div>
        </div>
      </section>

      <section className="panel mx-auto max-w-md text-center">
        <h2 className="text-xl font-bold">{t('pricingTitle')}</h2>
        <p className="mt-4 text-4xl font-extrabold">
          <span className="ltr-nums">{formatFils(3000, locale as 'en' | 'ar')}</span>
        </p>
        <p className="mt-1 font-semibold">{t('pricingBundle')}</p>
        <p className="text-slate-500">{t('pricingDetail')}</p>
        <p className="mt-3 text-sm text-slate-500">{t('vatNote', { total })}</p>
      </section>

      <section>
        <h2 className="mb-5 text-2xl font-bold">{t('useCasesTitle')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {(['shopping', 'subscriptions', 'trials', 'privacy'] as const).map((k) => (
            <div key={k} className="panel">
              {t(`useCases.${k}`)}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-5 text-2xl font-bold">{t('howTitle')}</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {(['1', '2', '3'] as const).map((k) => (
            <li key={k} className="panel">
              <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">
                {k}
              </span>
              {t(`how.${k}`)}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="mb-5 text-2xl font-bold">{t('faqTitle')}</h2>
        <div className="space-y-3">
          {(['1', '2', '3'] as const).map((k) => (
            <details key={k} className="panel">
              <summary className="cursor-pointer font-semibold">{t(`faq.q${k}`)}</summary>
              <p className="mt-2 text-slate-600">{t(`faq.a${k}`)}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
