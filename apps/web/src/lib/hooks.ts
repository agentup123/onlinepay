'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { api, ApiError } from './api';

/** Minimal data hook: loads on mount, exposes reload, redirects to login on 401. */
export function useApi<T>(path: string | null) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/login');
        return;
      }
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, [path, router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
