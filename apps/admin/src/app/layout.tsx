import type { Metadata } from 'next';
import Link from 'next/link';
import { LogoutButton } from './logout';
import './globals.css';

export const metadata: Metadata = {
  title: 'OnlinePay Admin',
  robots: { index: false, follow: false },
};

const NAV = [
  ['/', 'Overview'],
  ['/users', 'Users'],
  ['/kyc', 'KYC queue'],
  ['/flags', 'Monitoring'],
  ['/disputes', 'Disputes'],
  ['/purchases', 'Purchases'],
  ['/webhooks', 'Webhooks'],
  ['/audit', 'Audit log'],
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 bg-slate-900 p-4 text-slate-200">
            <p className="mb-6 font-bold text-white">OnlinePay Admin</p>
            <nav className="flex flex-col gap-1 text-sm">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="rounded px-2 py-1.5 hover:bg-slate-800">
                  {label}
                </Link>
              ))}
            </nav>
            <LogoutButton />
          </aside>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
