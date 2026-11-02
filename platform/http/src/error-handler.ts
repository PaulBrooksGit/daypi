import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { TenantContextError } from '../../db/src/with-tenant.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: err.issues },
      },
    });
    return;
  }

  if (err instanceof TenantContextError) {
    res.status(403).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // Postgres insufficient_privilege / RLS
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '42501') {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Access denied by data policy' },
    });
    return;
  }

  console.error('Unhandled error', {
    correlationId: req.correlationId,
    name: err instanceof Error ? err.name : 'unknown',
    message: err instanceof Error ? err.message : String(err),
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
