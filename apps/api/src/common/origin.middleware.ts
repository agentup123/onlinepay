import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Server-to-server endpoints authenticate by signature, not cookies.
const EXEMPT_PREFIXES = ['/webhooks/', '/health'];

/**
 * CSRF defence for cookie-authenticated routes: mutating requests must come from our own
 * web or admin origin. Combined with SameSite cookies this blocks cross-site form posts.
 * Registered as plain Express middleware in main.ts so it runs before routing.
 */
export function originCheck() {
  const webOrigin = new URL(env.WEB_URL).origin;
  const adminOrigin = new URL(env.ADMIN_URL).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
      return next();
    }
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    // Admin routes only from the admin app; consumer routes only from the consumer site. This
    // keeps the admin API off the public site even if a proxy is misconfigured.
    const expected = isAdminPath(req.path) ? adminOrigin : webOrigin;
    if (!origin || origin !== expected) {
      res.status(403).json({ statusCode: 403, code: 'BAD_ORIGIN' });
      return;
    }
    next();
  };
}

export function isAdminPath(path: string) {
  return path === '/admin' || path.startsWith('/admin/');
}

function refererOrigin(referer?: string): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
