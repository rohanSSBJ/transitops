// Timestamps are stored as UTC (matching the previous Prisma setup); make sure
// node-postgres parses "timestamp without time zone" values consistently.
process.env.TZ = 'UTC';

// Load .env when present (Node >= 20.6). Missing file is fine.
try {
  process.loadEnvFile();
} catch {
  /* no .env file - rely on real environment variables */
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  corsOrigin: process.env.CORS_ORIGIN,
  rateLimitLogin: parseInt(process.env.RATE_LIMIT_LOGIN || '5', 10),
  rateLimitGlobal: parseInt(process.env.RATE_LIMIT_GLOBAL || '100', 10),
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.jwtSecret || config.jwtSecret.startsWith('CHANGE_ME')) throw new Error('Set a real JWT_SECRET');
