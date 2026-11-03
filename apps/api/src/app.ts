import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { DbPool } from '../../../platform/db/src/index.js';
import type { AppConfig } from '../../../platform/config/src/index.js';
import {
  correlationMiddleware,
  createHostAllowlistMiddleware,
  errorHandler,
} from '../../../platform/http/src/index.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { childrenRoutes } from './routes/children.js';
import { guardiansRoutes } from './routes/guardians.js';
import { enquiriesRoutes } from './routes/enquiries.js';
import { sessionsRoutes } from './routes/sessions.js';
import { bookingsRoutes } from './routes/bookings.js';
import { attendanceRoutes } from './routes/attendance.js';
import { staffRoutes } from './routes/staff.js';
import { importExportRoutes } from './routes/import-export.js';
import { storageRoutes } from './routes/storage.js';
import { disabledRoutes } from './routes/disabled.js';

export function createApp(pool: DbPool, config: AppConfig) {
  const app = express();

  if (config.trustedProxies.length > 0) {
    app.set('trust proxy', config.trustedProxies);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(config.SESSION_SECRET));
  app.use(correlationMiddleware);
  app.use(createHostAllowlistMiddleware(config.allowedHosts));

  const v1 = express.Router();
  v1.use(healthRoutes(pool));
  v1.use(authRoutes(pool, config));
  v1.use(tenantRoutes(pool));
  v1.use(childrenRoutes(pool));
  v1.use(guardiansRoutes(pool));
  v1.use(enquiriesRoutes(pool));
  v1.use(sessionsRoutes(pool));
  v1.use(bookingsRoutes(pool));
  v1.use(attendanceRoutes(pool));
  v1.use(staffRoutes(pool));
  v1.use(importExportRoutes(pool));
  v1.use(storageRoutes(pool, config));
  v1.use(disabledRoutes());

  app.use('/v1', v1);

  app.use(errorHandler);
  return app;
}
