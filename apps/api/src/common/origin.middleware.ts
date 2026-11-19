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
  const allowed = new Set([new URL(env.WEB_URL).origin, new URL(env.ADMIN_URL).origin]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
      return next();
    }
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({ statusCode: 403, code: 'BAD_ORIGIN' });
      return;
    }
    next();
  };
}

function refererOrigin(referer?: string): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
