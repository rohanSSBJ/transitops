import { tooManyRequests } from '../lib/errors.js';

/** Fixed-window per-IP limiter (old config: 100 req/min globally, 5 req/min on login). */
export function rateLimit({ limit, ttlMs }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + ttlMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    // Occasional sweep so the map does not grow forever.
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > limit) return next(tooManyRequests());
    next();
  };
}
