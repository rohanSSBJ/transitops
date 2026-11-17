import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { validate } from '../lib/validate.js';
import { unauthorized } from '../lib/errors.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { config } from '../config.js';

export const authRouter = Router();

const loginLimiter = rateLimit({ limit: config.rateLimitLogin, ttlMs: 60000 });

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, minLength: 6 },
    });
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [dto.email]);
    const user = rows[0];
    if (!user) throw unauthorized('Invalid credentials');
    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) throw unauthorized('Invalid credentials');

    res.status(201).json({
      accessToken: signToken(user),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, email, name, role, created_at AS "createdAt" FROM users WHERE id = $1',
      [req.user.id],
    );
    if (!rows[0]) throw unauthorized('Invalid token');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
