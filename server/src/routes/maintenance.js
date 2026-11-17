import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { validate } from '../lib/validate.js';
import { parseListQuery, buildOrder, pageMeta } from '../lib/pagination.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { mapMaintenance } from '../lib/mapper.js';

export const maintenanceRouter = Router();
maintenanceRouter.use(authenticate);

const SORTABLE = {
  type: 'm.type', cost: 'm.cost', isOpen: 'm.is_open',
  openedAt: 'm.opened_at', closedAt: 'm.closed_at',
};
const SELECT = `
  m.*, v.id AS v_id, v.reg_no AS v_reg_no, v.name AS v_name, v.status AS v_status
  FROM maintenance_logs m JOIN vehicles v ON v.id = m.vehicle_id`;

function mapRowWithVehicle(row) {
  return {
    ...mapMaintenance(row),
    vehicle: { id: row.v_id, regNo: row.v_reg_no, name: row.v_name, status: row.v_status },
  };
}

maintenanceRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q, sort, vehicleId, isOpen } = parseListQuery(req.query, {
      vehicleId: { type: 'uuid' },
      isOpen: { type: 'boolean-string' },
    });
    const params = [];
    const where = [];
    if (vehicleId) { params.push(vehicleId); where.push(`m.vehicle_id = $${params.length}`); }
    if (isOpen !== undefined) { params.push(isOpen === 'true'); where.push(`m.is_open = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`m.type ILIKE $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(sort, SORTABLE, 'm.opened_at DESC');

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM maintenance_logs m ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(mapRowWithVehicle), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

maintenanceRouter.post('/', requireRoles('FLEET_MANAGER'), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      vehicleId: { type: 'uuid', required: true },
      type: { type: 'string', required: true, minLength: 1 },
      cost: { type: 'number', min: 0 },
      notes: { type: 'string' },
    });
    const log = await withTransaction(async (tx) => {
      const { rows: vehicles } = await tx.query('SELECT * FROM vehicles WHERE id = $1', [dto.vehicleId]);
      const vehicle = vehicles[0];
      if (!vehicle) throw notFound('Vehicle not found');
      if (vehicle.status === 'ON_TRIP') {
        throw unprocessable('Cannot open maintenance on a vehicle that is ON_TRIP');
      }
      if (vehicle.status === 'RETIRED') {
        throw unprocessable('Cannot open maintenance on a RETIRED vehicle');
      }
      const { rows } = await tx.query(
        `INSERT INTO maintenance_logs (id, vehicle_id, type, cost, notes, is_open)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
        [randomUUID(), dto.vehicleId, dto.type, dto.cost ?? 0, dto.notes ?? null],
      );
      await tx.query(`UPDATE vehicles SET status = 'IN_SHOP' WHERE id = $1`, [dto.vehicleId]);
      return rows[0];
    });
    res.status(201).json(mapMaintenance(log));
  } catch (err) {
    next(err);
  }
});

maintenanceRouter.post('/:id/close', requireRoles('FLEET_MANAGER'), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      cost: { type: 'number', min: 0 },
      notes: { type: 'string' },
    });
    const updated = await withTransaction(async (tx) => {
      const { rows: logs } = await tx.query('SELECT * FROM maintenance_logs WHERE id = $1', [req.params.id]);
      const log = logs[0];
      if (!log) throw notFound('Maintenance record not found');
      if (!log.is_open) {
        throw unprocessable('Maintenance record is already closed');
      }
      const { rows } = await tx.query(
        `UPDATE maintenance_logs
         SET is_open = false, closed_at = NOW(), cost = $1, notes = $2
         WHERE id = $3 RETURNING *`,
        [dto.cost ?? log.cost, dto.notes ?? log.notes, req.params.id],
      );
      const { rows: vehicles } = await tx.query('SELECT * FROM vehicles WHERE id = $1', [log.vehicle_id]);
      const vehicle = vehicles[0];
      // Do not resurrect a retired vehicle.
      if (vehicle && vehicle.status !== 'RETIRED') {
        await tx.query(`UPDATE vehicles SET status = 'AVAILABLE' WHERE id = $1`, [log.vehicle_id]);
      }
      return rows[0];
    });
    res.status(201).json(mapMaintenance(updated));
  } catch (err) {
    next(err);
  }
});
