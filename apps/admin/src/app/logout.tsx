'use client';

import { api } from '@/lib/api';

export function LogoutButton() {
  return (
    <button
      className="mt-8 text-xs text-slate-400 hover:text-white"
      onClick={async () => {
        await api('/admin/auth/logout', { body: {} }).catch(() => undefined);
        window.location.assign('/login');
      }}
    >
      Log out
    </button>
  );
}
