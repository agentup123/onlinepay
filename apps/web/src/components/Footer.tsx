import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';

export function Footer() {
  const t = useTranslations('legal');
  const tf = useTranslations('footer');
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl">{tf('issuer')}</p>
        <div className="flex gap-4">
          <Link href="/legal/terms">{t('terms')}</Link>
          <Link href="/legal/privacy">{t('privacy')}</Link>
          <Link href="/legal/fees">{t('fees')}</Link>
        </div>
      </div>
    </footer>
  );
}
