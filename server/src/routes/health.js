import { Router } from 'express';
import { query } from '../db.js';
import { serviceUnavailable } from '../lib/errors.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'transitops-api',
      timestamp: new Date().toISOString(),
    });
  } catch {
    next(serviceUnavailable('Database unavailable'));
  }
});
