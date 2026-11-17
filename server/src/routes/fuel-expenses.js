import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { validate } from '../lib/validate.js';
import { parseListQuery, buildOrder, pageMeta } from '../lib/pagination.js';
import { notFound } from '../lib/errors.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { mapFuelLog, mapExpense } from '../lib/mapper.js';

const WRITE_ROLES = ['FINANCIAL_ANALYST', 'FLEET_MANAGER'];

async function assertVehicle(vehicleId) {
  const { rows } = await query('SELECT id FROM vehicles WHERE id = $1', [vehicleId]);
  if (!rows[0]) throw notFound('Vehicle not found');
}

const VEHICLE_SUMMARY = `v.id AS v_id, v.reg_no AS v_reg_no, v.name AS v_name`;
const withVehicle = (base) => (row) => ({
  ...base(row),
  vehicle: { id: row.v_id, regNo: row.v_reg_no, name: row.v_name },
});

// ---- Fuel logs ----
export const fuelLogsRouter = Router();
fuelLogsRouter.use(authenticate);

fuelLogsRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, sort, vehicleId } = parseListQuery(req.query, {
      vehicleId: { type: 'uuid' },
    });
    const params = [];
    const where = [];
    if (vehicleId) { params.push(vehicleId); where.push(`f.vehicle_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(sort, { liters: 'f.liters', cost: 'f.cost', date: 'f.date' }, 'f.date DESC');

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT f.*, ${VEHICLE_SUMMARY} FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id
         ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM fuel_logs f ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(withVehicle(mapFuelLog)), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

fuelLogsRouter.post('/', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      vehicleId: { type: 'uuid', required: true },
      tripId: { type: 'uuid' },
      liters: { type: 'number', required: true, min: 0 },
      cost: { type: 'number', required: true, min: 0 },
      date: { type: 'date' },
    });
    await assertVehicle(dto.vehicleId);
    const { rows } = await query(
      `INSERT INTO fuel_logs (id, vehicle_id, trip_id, liters, cost, date)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW())) RETURNING *`,
      [randomUUID(), dto.vehicleId, dto.tripId ?? null, dto.liters, dto.cost,
       dto.date ? new Date(dto.date) : null],
    );
    res.status(201).json(mapFuelLog(rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---- Expenses ----
export const expensesRouter = Router();
expensesRouter.use(authenticate);

expensesRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q, sort, vehicleId } = parseListQuery(req.query, {
      vehicleId: { type: 'uuid' },
    });
    const params = [];
    const where = [];
    if (vehicleId) { params.push(vehicleId); where.push(`e.vehicle_id = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`e.category ILIKE $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(
      sort, { category: 'e.category', amount: 'e.amount', date: 'e.date' }, 'e.date DESC',
    );

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT e.*, ${VEHICLE_SUMMARY} FROM expenses e JOIN vehicles v ON v.id = e.vehicle_id
         ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM expenses e ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(withVehicle(mapExpense)), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

expensesRouter.get('/rollup', async (req, res, next) => {
  try {
    const vehicleId = req.query.vehicleId;
    // Same tolerance as the old endpoint: vehicleId was a plain string query param.
    const params = [];
    let fuelWhere = '';
    if (vehicleId) { params.push(vehicleId); fuelWhere = 'WHERE vehicle_id = $1'; }

    const [fuel, expense, maintenance] = await Promise.all([
      query(`SELECT COALESCE(SUM(cost), 0)::float AS s FROM fuel_logs ${fuelWhere}`, params),
      query(`SELECT COALESCE(SUM(amount), 0)::float AS s FROM expenses ${fuelWhere}`, params),
      query(`SELECT COALESCE(SUM(cost), 0)::float AS s FROM maintenance_logs ${fuelWhere}`, params),
    ]);
    const fuelCost = fuel.rows[0].s;
    const expenseCost = expense.rows[0].s;
    const maintenanceCost = maintenance.rows[0].s;
    res.json({
      vehicleId: vehicleId ?? null,
      fuelCost,
      expenseCost,
      maintenanceCost,
      operationalCost: fuelCost + maintenanceCost,
      totalCost: fuelCost + expenseCost + maintenanceCost,
    });
  } catch (err) {
    next(err);
  }
});

expensesRouter.post('/', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      vehicleId: { type: 'uuid', required: true },
      category: { type: 'string', required: true, minLength: 1 },
      amount: { type: 'number', required: true, min: 0 },
      date: { type: 'date' },
    });
    await assertVehicle(dto.vehicleId);
    const { rows } = await query(
      `INSERT INTO expenses (id, vehicle_id, category, amount, date)
       VALUES ($1,$2,$3,$4,COALESCE($5, NOW())) RETURNING *`,
      [randomUUID(), dto.vehicleId, dto.category, dto.amount,
       dto.date ? new Date(dto.date) : null],
    );
    res.status(201).json(mapExpense(rows[0]));
  } catch (err) {
    next(err);
  }
});
