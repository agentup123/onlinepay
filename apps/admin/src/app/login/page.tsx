'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';

export default function AdminLogin() {
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/admin/auth/login', {
        body: { email: f.get('email'), password: f.get('password'), totp: f.get('totp') },
      });
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const input = 'w-full rounded border border-slate-300 px-3 py-2';
  return (
    <form
      onSubmit={submit}
      className="mx-auto mt-16 max-w-sm space-y-3 rounded-lg bg-white p-6 shadow"
    >
      <h1 className="text-lg font-bold">Admin sign in</h1>
      <input
        className={input}
        name="email"
        type="email"
        placeholder="Email"
        required
        autoComplete="username"
      />
      <input
        className={input}
        name="password"
        type="password"
        placeholder="Password"
        required
        autoComplete="current-password"
      />
      <input
        className={input}
        name="totp"
        inputMode="numeric"
        pattern="\d{6}"
        placeholder="Authenticator code"
        required
        autoComplete="one-time-code"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="w-full rounded bg-slate-900 py-2 font-semibold text-white">Sign in</button>
    </form>
  );
}
