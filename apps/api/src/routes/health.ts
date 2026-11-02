import { Router } from 'express';
import type { DbPool } from '../../../../platform/db/src/index.js';

export function healthRoutes(pool: DbPool): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
