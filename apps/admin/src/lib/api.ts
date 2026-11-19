'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatFils } from '@onlinepay/shared';

export const aed = (fils: number) => formatFils(fils);
export const dt = (iso: string) =>
  new Date(iso).toLocaleString('en-AE', { timeZone: 'Asia/Dubai' });

/** One key per admin action: retries of the same action are deduplicated by the API. */
export function newIdempotencyKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (
    res.status === 401 &&
    typeof window !== 'undefined' &&
    !window.location.pathname.startsWith('/login')
  ) {
    window.location.assign('/login');
  }
  if (!res.ok)
    throw new Error(
      (data && (data.code || data.message?.code || JSON.stringify(data.message))) ||
        `HTTP ${res.status}`,
    );
  return data as T;
}

export function useAdminApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Every destructive admin action asks for a written reason, which lands in the audit log. */
export function askReason(action: string): string | null {
  const reason = window.prompt(`Reason for: ${action} (min 5 characters, stored in the audit log)`);
  return reason && reason.trim().length >= 5 ? reason.trim() : null;
}
