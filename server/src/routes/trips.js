import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { validate } from '../lib/validate.js';
import { parseListQuery, buildOrder, pageMeta } from '../lib/pagination.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { mapTripRow, TRIP_SELECT } from '../lib/mapper.js';

export const tripsRouter = Router();
tripsRouter.use(authenticate);

const STATUSES = ['DRAFT', 'DISPATCHED', 'COMPLETED', 'CANCELLED'];
const WRITE_ROLES = ['DRIVER', 'FLEET_MANAGER'];
const SORTABLE = {
  source: 't.source', destination: 't.destination', cargoWeight: 't.cargo_weight',
  status: 't.status', createdAt: 't.created_at',
};

/**
 * Pure business-rule guard for dispatching a trip. Throws 422 on any violation.
 * Same rules and messages as the old TripsService.assertDispatchable.
 */
export function assertDispatchable(trip, vehicle, driver) {
  if (trip.status !== 'DRAFT') {
    throw unprocessable(`Only DRAFT trips can be dispatched (current: ${trip.status})`);
  }
  if (vehicle.status !== 'AVAILABLE') {
    throw unprocessable(`Vehicle is not available for dispatch (status: ${vehicle.status})`);
  }
  if (driver.status === 'SUSPENDED') {
    throw unprocessable('Driver is suspended');
  }
  if (driver.status !== 'AVAILABLE') {
    throw unprocessable(`Driver is not available for dispatch (status: ${driver.status})`);
  }
  if (new Date(driver.license_expiry).getTime() <= Date.now()) {
    throw unprocessable('Driver license has expired');
  }
  if (trip.cargo_weight > vehicle.max_load_kg) {
    throw unprocessable(
      `Cargo weight (${trip.cargo_weight}kg) exceeds vehicle max load (${vehicle.max_load_kg}kg)`,
    );
  }
}

tripsRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, q, sort, status, vehicleId, driverId } = parseListQuery(req.query, {
      status: { type: 'enum', values: STATUSES },
      vehicleId: { type: 'uuid' },
      driverId: { type: 'uuid' },
    });
    const params = [];
    const where = [];
    if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
    if (vehicleId) { params.push(vehicleId); where.push(`t.vehicle_id = $${params.length}`); }
    if (driverId) { params.push(driverId); where.push(`t.driver_id = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(t.source ILIKE $${params.length} OR t.destination ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = buildOrder(sort, SORTABLE, 't.created_at DESC');

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${TRIP_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*)::int AS total FROM trips t ${whereSql}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({ data: dataResult.rows.map(mapTripRow), meta: pageMeta(total, page, limit) });
  } catch (err) {
    next(err);
  }
});

tripsRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${TRIP_SELECT} WHERE t.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Trip not found');
    res.json(mapTripRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

tripsRouter.post('/', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      source: { type: 'string', required: true, minLength: 1 },
      destination: { type: 'string', required: true, minLength: 1 },
      vehicleId: { type: 'uuid', required: true },
      driverId: { type: 'uuid', required: true },
      cargoWeight: { type: 'number', required: true, min: 0, minMessage: 'cargoWeight must be >= 0' },
      plannedDistance: { type: 'number', required: true, min: 0, minMessage: 'plannedDistance must be >= 0' },
      revenue: { type: 'number', min: 0 },
    });
    const [vehicles, drivers] = await Promise.all([
      query('SELECT id FROM vehicles WHERE id = $1', [dto.vehicleId]),
      query('SELECT id FROM drivers WHERE id = $1', [dto.driverId]),
    ]);
    if (!vehicles.rows[0]) throw notFound('Vehicle not found');
    if (!drivers.rows[0]) throw notFound('Driver not found');

    const id = randomUUID();
    await query(
      `INSERT INTO trips (id, source, destination, vehicle_id, driver_id, created_by_id,
                          cargo_weight, planned_distance, revenue, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT')`,
      [id, dto.source, dto.destination, dto.vehicleId, dto.driverId, req.user.id,
       dto.cargoWeight, dto.plannedDistance, dto.revenue ?? null],
    );
    const { rows } = await query(`SELECT ${TRIP_SELECT} WHERE t.id = $1`, [id]);
    res.status(201).json(mapTripRow(rows[0]));
  } catch (err) {
    next(err);
  }
});

tripsRouter.post('/:id/dispatch', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const trip = await withTransaction(async (tx) => {
      const { rows: trips } = await tx.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [req.params.id]);
      const tripRow = trips[0];
      if (!tripRow) throw notFound('Trip not found');
      const { rows: vehicles } = await tx.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [tripRow.vehicle_id]);
      const { rows: drivers } = await tx.query('SELECT * FROM drivers WHERE id = $1 FOR UPDATE', [tripRow.driver_id]);
      if (!vehicles[0]) throw notFound('Vehicle not found');
      if (!drivers[0]) throw notFound('Driver not found');

      assertDispatchable(tripRow, vehicles[0], drivers[0]);

      await tx.query(`UPDATE vehicles SET status = 'ON_TRIP' WHERE id = $1`, [vehicles[0].id]);
      await tx.query(`UPDATE drivers SET status = 'ON_TRIP' WHERE id = $1`, [drivers[0].id]);
      await tx.query(`UPDATE trips SET status = 'DISPATCHED' WHERE id = $1`, [req.params.id]);
      const { rows } = await tx.query(`SELECT ${TRIP_SELECT} WHERE t.id = $1`, [req.params.id]);
      return rows[0];
    });
    res.status(201).json(mapTripRow(trip));
  } catch (err) {
    next(err);
  }
});

tripsRouter.post('/:id/complete', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const dto = validate(req.body, {
      finalOdometer: { type: 'number', required: true, min: 0 },
      fuelConsumed: { type: 'number', required: true, min: 0 },
      revenue: { type: 'number', min: 0 },
    });
    const trip = await withTransaction(async (tx) => {
      const { rows: trips } = await tx.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [req.params.id]);
      const tripRow = trips[0];
      if (!tripRow) throw notFound('Trip not found');
      if (tripRow.status !== 'DISPATCHED') {
        throw unprocessable(`Only DISPATCHED trips can be completed (current: ${tripRow.status})`);
      }
      await tx.query(
        `UPDATE vehicles SET status = 'AVAILABLE', odometer = $1 WHERE id = $2`,
        [dto.finalOdometer, tripRow.vehicle_id],
      );
      await tx.query(`UPDATE drivers SET status = 'AVAILABLE' WHERE id = $1`, [tripRow.driver_id]);
      await tx.query(
        `UPDATE trips SET status = 'COMPLETED', final_odometer = $1, fuel_consumed = $2,
                          revenue = $3 WHERE id = $4`,
        [dto.finalOdometer, dto.fuelConsumed, dto.revenue ?? tripRow.revenue, req.params.id],
      );
      const { rows } = await tx.query(`SELECT ${TRIP_SELECT} WHERE t.id = $1`, [req.params.id]);
      return rows[0];
    });
    res.status(201).json(mapTripRow(trip));
  } catch (err) {
    next(err);
  }
});

tripsRouter.post('/:id/cancel', requireRoles(...WRITE_ROLES), async (req, res, next) => {
  try {
    const trip = await withTransaction(async (tx) => {
      const { rows: trips } = await tx.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [req.params.id]);
      const tripRow = trips[0];
      if (!tripRow) throw notFound('Trip not found');
      if (tripRow.status === 'COMPLETED' || tripRow.status === 'CANCELLED') {
        throw unprocessable(`Cannot cancel a ${tripRow.status} trip`);
      }
      if (tripRow.status === 'DISPATCHED') {
        await tx.query(`UPDATE vehicles SET status = 'AVAILABLE' WHERE id = $1`, [tripRow.vehicle_id]);
        await tx.query(`UPDATE drivers SET status = 'AVAILABLE' WHERE id = $1`, [tripRow.driver_id]);
      }
      await tx.query(`UPDATE trips SET status = 'CANCELLED' WHERE id = $1`, [req.params.id]);
      const { rows } = await tx.query(`SELECT ${TRIP_SELECT} WHERE t.id = $1`, [req.params.id]);
      return rows[0];
    });
    res.status(201).json(mapTripRow(trip));
  } catch (err) {
    next(err);
  }
});
