import express from 'express';
import { config } from './config.js';
import { rateLimit } from './middleware/rate-limit.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { driversRouter } from './routes/drivers.js';
import { tripsRouter } from './routes/trips.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { fuelLogsRouter, expensesRouter } from './routes/fuel-expenses.js';
import { analyticsRouter } from './routes/analytics.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // CORS: reflect configured origin list, or any origin when unset (old behavior).
  app.use((req, res, next) => {
    const allowed = config.corsOrigin
      ? config.corsOrigin.split(',').map((o) => o.trim())
      : null;
    const origin = req.headers.origin;
    if (!allowed || (origin && allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (allowed && allowed.length) {
      res.setHeader('Access-Control-Allow-Origin', allowed[0]);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Global throttle: 100 requests/minute per IP (old ThrottlerGuard config).
  app.use(rateLimit({ limit: config.rateLimitGlobal, ttlMs: 60000 }));

  app.use('/api/auth', authRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/vehicles', vehiclesRouter);
  app.use('/api/drivers', driversRouter);
  app.use('/api/trips', tripsRouter);
  app.use('/api/maintenance', maintenanceRouter);
  app.use('/api/fuel-logs', fuelLogsRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/analytics', analyticsRouter);

  // Unknown routes: same 404 wording Nest produced.
  app.use((req, _res, next) => {
    next(Object.assign(new Error(`Cannot ${req.method} ${req.originalUrl}`), {
      statusCode: 404, error: 'Not Found', expose: true,
    }));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.statusCode === 404 && err.expose) {
      return res.status(404).json({
        statusCode: 404,
        error: 'Not Found',
        message: err.message,
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
      });
    }
    errorHandler(err, req, res, next);
  });

  return app;
}
