import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { validate } from '../lib/validate.js';
import { parseListQuery, buildOrder, pageMeta } from '../lib/pagination.js';
import { notFound } from '../lib/errors.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { mapDriver } from '../lib/mapper.js';

export const driversRouter = Router();
driversRouter.use(authenticate);

const STATUSES = ['AVAILABLE', 'ON_TRIP', 'OFF_DUTY', 'SUSPENDED'];
const WRITE_ROLES = ['SAFETY_OFFICER', 'FLEET_MANAGER'];
const SORTABLE = {
  name: 'name', licenseNo: 'license_no', licenseCategory: 'license_category',
  licenseExpiry: 'license_expiry', safetyScore: 'safety_score',
  status: 'status', createdAt: 'created_at',
};
const FIELD_SCHEMA = {
  name: { type: 'string', minLength: 1 },
  licenseNo: { type: 'string', minLength: 1 },
  licenseCategory: { type: 'string', minLength: 1 },
  licenseExpiry: { type: 'date' },
  contact: { type: 'string' },
  safetyScore: { type: 'number', min: 0, max: 100 },
  status: { type: 'enum', values: STATUSES },
};

async function findDriver(id) {
  const { rows } = await query('SELECT * FROM drivers WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Driver not found');
  return rows[0];
}

driversRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q, sort, status } = parseListQuery(req.query, {
      status: { type: 'enum', values: STATUSES },
    });
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(name ILIKE $${params.length} OR license_no ILIKE $${params.length} OR license_category ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(sort, SORTABLE, 'created_at DESC');

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT * FROM drivers ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM drivers ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(mapDriver), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

driversRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(mapDriver(await findDriver(req.params.id)));
  } catch (err) {
    next(err);
  }
});

driversRouter.post('/', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const dto = validate(req.body, Object.fromEntries(
      Object.entries(FIELD_SCHEMA).map(([k, v]) => [
        k, { ...v, required: ['name', 'licenseNo', 'licenseCategory', 'licenseExpiry'].includes(k) },
      ]),
    ));
    const { rows } = await query(
      `INSERT INTO drivers (id, name, license_no, license_category, license_expiry, contact, safety_score, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), dto.name, dto.licenseNo, dto.licenseCategory,
       new Date(dto.licenseExpiry), dto.contact ?? null, dto.safetyScore ?? 100,
       dto.status ?? 'AVAILABLE'],
    );
    res.status(201).json(mapDriver(rows[0]));
  } catch (err) {
    next(err);
  }
});

driversRouter.patch('/:id', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    await findDriver(req.params.id);
    const dto = validate(req.body, FIELD_SCHEMA);
    const columns = {
      name: 'name', licenseNo: 'license_no', licenseCategory: 'license_category',
      licenseExpiry: 'license_expiry', contact: 'contact',
      safetyScore: 'safety_score', status: 'status',
    };
    const sets = [];
    const params = [];
    for (const [field, value] of Object.entries(dto)) {
      params.push(field === 'licenseExpiry' ? new Date(value) : value);
      sets.push(`${columns[field]} = $${params.length}`);
    }
    if (sets.length) {
      params.push(req.params.id);
      await query(`UPDATE drivers SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    res.json(mapDriver(await findDriver(req.params.id)));
  } catch (err) {
    next(err);
  }
});

driversRouter.delete('/:id', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    await findDriver(req.params.id);
    await query('DELETE FROM drivers WHERE id = $1', [req.params.id]);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});
