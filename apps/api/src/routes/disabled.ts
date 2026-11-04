import { Router } from 'express';
import { featureDisabled } from '../../../../platform/http/src/errors.js';

/** Explicit hard gates for D01–D12 dependent features. */
export function disabledRoutes(): Router {
  const router = Router();

  router.all('/payments/collect', (_req, _res, next) => {
    next(featureDisabled('payments.collect_live'));
  });

  router.all('/payroll/*', (_req, _res, next) => {
    next(featureDisabled('payroll.submit'));
  });

  router.all('/dayswap/*', (_req, _res, next) => {
    next(featureDisabled('dayswap'));
  });

  router.all('/daysale/*', (_req, _res, next) => {
    next(featureDisabled('daysale'));
  });

  return router;
}
