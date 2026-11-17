import { Router } from 'express';
import { query } from '../db.js';
import { validate } from '../lib/validate.js';
import { parseListQuery, buildOrder, pageMeta } from '../lib/pagination.js';
import { notFound } from '../lib/errors.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { mapVehicle } from '../lib/mapper.js';
import { randomUUID } from 'node:crypto';

export const vehiclesRouter = Router();
vehiclesRouter.use(authenticate);

const STATUSES = ['AVAILABLE', 'ON_TRIP', 'IN_SHOP', 'RETIRED'];
const SORTABLE = {
  regNo: 'reg_no', name: 'name', type: 'type', maxLoadKg: 'max_load_kg',
  odometer: 'odometer', status: 'status', createdAt: 'created_at',
};
const FIELD_SCHEMA = {
  regNo: { type: 'string', minLength: 1 },
  name: { type: 'string', minLength: 1 },
  type: { type: 'string', minLength: 1 },
  maxLoadKg: { type: 'number', min: 0.01, minMessage: 'maxLoadKg must be greater than 0' },
  odometer: { type: 'number', min: 0 },
  acquisitionCost: { type: 'number', min: 0 },
  status: { type: 'enum', values: STATUSES },
};

async function findVehicle(id) {
  const { rows } = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Vehicle not found');
  return rows[0];
}

vehiclesRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q, sort, status, type } = parseListQuery(req.query, {
      status: { type: 'enum', values: STATUSES },
      type: { type: 'string' },
    });
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (type) { params.push(type); where.push(`LOWER(type) = LOWER($${params.length})`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(reg_no ILIKE $${params.length} OR name ILIKE $${params.length} OR type ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(sort, SORTABLE, 'created_at DESC');

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT * FROM vehicles ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM vehicles ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(mapVehicle), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

vehiclesRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(mapVehicle(await findVehicle(req.params.id)));
  } catch (err) {
    next(err);
  }
});

vehiclesRouter.post('/', requireRoles('FLEET_MANAGER'), async (req, res, next) => {
  try {
    const dto = validate(req.body, Object.fromEntries(
      Object.entries(FIELD_SCHEMA).map(([k, v]) => [
        k, { ...v, required: ['regNo', 'name', 'type', 'maxLoadKg'].includes(k) },
      ]),
    ));
    const { rows } = await query(
      `INSERT INTO vehicles (id, reg_no, name, type, max_load_kg, odometer, acquisition_cost, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), dto.regNo, dto.name, dto.type, dto.maxLoadKg,
       dto.odometer ?? 0, dto.acquisitionCost ?? 0, dto.status ?? 'AVAILABLE'],
    );
    res.status(201).json(mapVehicle(rows[0]));
  } catch (err) {
    next(err);
  }
});

vehiclesRouter.patch('/:id', requireRoles('FLEET_MANAGER'), async (req, res, next) => {
  try {
    await findVehicle(req.params.id);
    const dto = validate(req.body, FIELD_SCHEMA);
    const columns = {
      regNo: 'reg_no', name: 'name', type: 'type', maxLoadKg: 'max_load_kg',
      odometer: 'odometer', acquisitionCost: 'acquisition_cost', status: 'status',
    };
    const sets = [];
    const params = [];
    for (const [field, value] of Object.entries(dto)) {
      params.push(value);
      sets.push(`${columns[field]} = $${params.length}`);
    }
    if (sets.length) {
      params.push(req.params.id);
      await query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    res.json(mapVehicle(await findVehicle(req.params.id)));
  } catch (err) {
    next(err);
  }
});

vehiclesRouter.delete('/:id', requireRoles('FLEET_MANAGER'), async (req, res, next) => {
  try {
    await findVehicle(req.params.id);
    await query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});
