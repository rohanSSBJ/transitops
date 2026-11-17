import { ApiError } from '../lib/errors.js';

// Postgres unique-constraint name -> old Prisma P2002 target fields.
const UNIQUE_TARGETS = {
  users_email_key: 'email',
  vehicles_reg_no_key: 'regNo',
  drivers_license_no_key: 'licenseNo',
};

const DB_DOWN_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  '57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '53300',
]);

/** Same response shape as the old AllExceptionsFilter. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let message = 'Internal server error';
  let error = 'Internal Server Error';

  if (err instanceof ApiError) {
    status = err.statusCode;
    message = err.message;
    error = err.error;
  } else if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    status = 400;
    message = err.message;
    error = 'Bad Request';
  } else if (err?.code === '23505') {
    // unique violation -> old Prisma P2002 mapping
    status = 422;
    const target = UNIQUE_TARGETS[err.constraint] ?? err.constraint ?? '';
    message = `Unique constraint failed${target ? ` on: ${target}` : ''}`;
    error = 'Unprocessable Entity';
  } else if (err?.code === '23503') {
    // foreign-key violation -> old Prisma P2003 mapping
    status = 422;
    message = 'Related record constraint failed';
    error = 'Unprocessable Entity';
  } else if (err?.code && DB_DOWN_CODES.has(err.code)) {
    status = 503;
    message = 'Database unavailable';
    error = 'Service Unavailable';
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (status >= 500) {
    console.error(`${req.method} ${req.originalUrl} -> ${status}`, err?.stack);
  }

  res.status(status).json({
    statusCode: status,
    error,
    message,
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
}
