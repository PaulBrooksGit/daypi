import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id') ?? req.header('x-correlation-id');
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
  req.correlationId = id;
  res.setHeader('x-request-id', id);
  next();
}
