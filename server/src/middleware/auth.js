import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { unauthorized, forbidden } from '../lib/errors.js';

/** Bearer-token authentication; loads the user like the old JwtStrategy.validate. */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization;
    const token =
      header && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized();
    }
    const { rows } = await query(
      'SELECT id, email, role, name FROM users WHERE id = $1',
      [payload.sub],
    );
    if (!rows[0]) throw unauthorized('Invalid token');
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/** Role gate, mirroring the old RolesGuard message. */
export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(
        forbidden('You do not have permission to perform this action'),
      );
    }
    next();
  };
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}
