import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.js';

function normaliseHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().split(':')[0];
  if (!host || host.includes('/') || host.includes(' ') || host.includes('\\')) return null;
  // Reject sneaky suffixes like daypi.example.evil.com when only example is allowlisted
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

export function createHostAllowlistMiddleware(allowedHosts: string[]) {
  const allow = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return function hostAllowlist(req: Request, _res: Response, next: NextFunction): void {
    const host = normaliseHost(req.headers.host);
    if (!host || !allow.has(host)) {
      next(new AppError('HOST_REJECTED', 'Unrecognised or malformed host', 400));
      return;
    }
    next();
  };
}

export { normaliseHost };
