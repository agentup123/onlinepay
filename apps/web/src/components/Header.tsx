'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/routing';
import { api } from '@/lib/api';

export function Header() {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const inApp =
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/kyc') ||
    pathname.startsWith('/checkout');
  const otherLocale = locale === 'ar' ? 'en' : 'ar';

  const switchLocale = async () => {
    router.replace(pathname, { locale: otherLocale });
    if (inApp)
      await api('/me/preferences', { method: 'PATCH', body: { locale: otherLocale } }).catch(
        () => undefined,
      );
  };

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    router.replace('/');
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
        <Link href={inApp ? '/dashboard' : '/'} className="text-lg font-bold text-brand-700">
          {tc('appName')}
        </Link>
        <nav className="flex items-center gap-1 text-sm sm:gap-3">
          {inApp ? (
            <>
              <Link
                className="hidden rounded-lg px-2 py-1 hover:bg-slate-100 sm:inline"
                href="/dashboard"
              >
                {t('dashboard')}
              </Link>
              <Link
                className="hidden rounded-lg px-2 py-1 hover:bg-slate-100 sm:inline"
                href="/dashboard/wallet"
              >
                {t('wallet')}
              </Link>
              <Link
                className="hidden rounded-lg px-2 py-1 hover:bg-slate-100 sm:inline"
                href="/dashboard/invoices"
              >
                {t('invoices')}
              </Link>
              <Link
                className="rounded-lg px-2 py-1 hover:bg-slate-100"
                href="/dashboard/notifications"
                aria-label={t('notifications')}
              >
                🔔
              </Link>
              <button className="rounded-lg px-2 py-1 hover:bg-slate-100" onClick={logout}>
                {t('logout')}
              </button>
            </>
          ) : (
            <>
              <Link className="rounded-lg px-2 py-1 hover:bg-slate-100" href="/login">
                {t('login')}
              </Link>
              <Link className="btn-primary" href="/signup">
                {t('signup')}
              </Link>
            </>
          )}
          <button
            className="rounded-lg px-2 py-1 font-medium hover:bg-slate-100"
            onClick={switchLocale}
            lang={otherLocale}
          >
            {t('language')}
          </button>
        </nav>
      </div>
      {inApp && (
        <nav className="flex justify-around border-t border-slate-100 py-2 text-sm sm:hidden">
          <Link href="/dashboard">{t('dashboard')}</Link>
          <Link href="/dashboard/wallet">{t('wallet')}</Link>
          <Link href="/dashboard/invoices">{t('invoices')}</Link>
        </nav>
      )}
    </header>
  );
}
