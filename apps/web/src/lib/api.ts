'use client';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: unknown,
  ) {
    super(code);
  }
}

export function newIdempotencyKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Browser → same-origin /api (proxied to the NestJS API by next.config rewrites).
 * Cookies are httpOnly and sent automatically; nothing sensitive is stored in JS.
 */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const code = (data && (data.code || data.message?.code || data.message)) || `HTTP_${res.status}`;
    throw new ApiError(res.status, typeof code === 'string' ? code : `HTTP_${res.status}`, data);
  }
  return data as T;
}
