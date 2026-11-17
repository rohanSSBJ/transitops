import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

/** Dashboard KPIs - same formulas and rounding as the old AnalyticsService. */
async function kpis() {
  const [
    vehiclesByStatus, driversByStatus, tripsByStatus,
    fuelAgg, maintAgg, completedTrips, acqAgg,
    expiredLicenses, expiringLicenses, openMaintenance,
  ] = await Promise.all([
    query(`SELECT status, COUNT(*)::int AS c FROM vehicles GROUP BY status ORDER BY status ASC`),
    query(`SELECT status, COUNT(*)::int AS c FROM drivers GROUP BY status ORDER BY status ASC`),
    query(`SELECT status, COUNT(*)::int AS c FROM trips GROUP BY status ORDER BY status ASC`),
    query(`SELECT COALESCE(SUM(cost),0)::float AS cost, COALESCE(SUM(liters),0)::float AS liters FROM fuel_logs`),
    query(`SELECT COALESCE(SUM(cost),0)::float AS cost FROM maintenance_logs`),
    query(`SELECT COALESCE(SUM(revenue),0)::float AS revenue,
                  COALESCE(SUM(planned_distance),0)::float AS distance,
                  COALESCE(SUM(fuel_consumed),0)::float AS fuel
           FROM trips WHERE status = 'COMPLETED'`),
    query(`SELECT COALESCE(SUM(acquisition_cost),0)::float AS cost FROM vehicles`),
    query(`SELECT COUNT(*)::int AS c FROM drivers WHERE license_expiry < NOW()`),
    query(`SELECT COUNT(*)::int AS c FROM drivers
           WHERE license_expiry >= NOW() AND license_expiry <= NOW() + INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS c FROM maintenance_logs WHERE is_open = true`),
  ]);

  const countBy = (rows) =>
    rows.reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

  const vStatus = countBy(vehiclesByStatus.rows);
  const totalVehicles = Object.values(vStatus).reduce((a, b) => a + b, 0);
  const onTrip = vStatus['ON_TRIP'] ?? 0;
  const operational = totalVehicles - (vStatus['RETIRED'] ?? 0);

  const fuelCost = fuelAgg.rows[0].cost;
  const maintenanceCost = maintAgg.rows[0].cost;
  const totalRevenue = completedTrips.rows[0].revenue;
  const totalDistance = completedTrips.rows[0].distance;
  const totalFuelConsumed = completedTrips.rows[0].fuel;
  const acquisitionCost = acqAgg.rows[0].cost;

  const operationalCost = fuelCost + maintenanceCost;

  return {
    fleetUtilizationPct:
      operational > 0 ? Number(((onTrip / operational) * 100).toFixed(1)) : 0,
    fuelEfficiency:
      totalFuelConsumed > 0
        ? Number((totalDistance / totalFuelConsumed).toFixed(2))
        : 0,
    operationalCost,
    fuelCost,
    maintenanceCost,
    totalRevenue,
    fleetRoi:
      acquisitionCost > 0
        ? Number(((totalRevenue - operationalCost) / acquisitionCost).toFixed(3))
        : 0,
    counts: {
      vehicles: { total: totalVehicles, byStatus: vStatus },
      drivers: { byStatus: countBy(driversByStatus.rows) },
      trips: { byStatus: countBy(tripsByStatus.rows) },
    },
    alerts: {
      expiredLicenses: expiredLicenses.rows[0].c,
      expiringLicenses: expiringLicenses.rows[0].c,
      openMaintenance: openMaintenance.rows[0].c,
    },
  };
}

/** Per-vehicle report rows (also used by the CSV export). */
async function vehicleReport() {
  const { rows: vehicles } = await query('SELECT * FROM vehicles ORDER BY reg_no ASC');
  return Promise.all(
    vehicles.map(async (v) => {
      const [fuel, maint, trips] = await Promise.all([
        query(`SELECT COALESCE(SUM(cost),0)::float AS s FROM fuel_logs WHERE vehicle_id = $1`, [v.id]),
        query(`SELECT COALESCE(SUM(cost),0)::float AS s FROM maintenance_logs WHERE vehicle_id = $1`, [v.id]),
        query(`SELECT COALESCE(SUM(revenue),0)::float AS s FROM trips WHERE vehicle_id = $1 AND status = 'COMPLETED'`, [v.id]),
      ]);
      const fuelCost = fuel.rows[0].s;
      const maintenanceCost = maint.rows[0].s;
      const revenue = trips.rows[0].s;
      const roi =
        v.acquisition_cost > 0
          ? Number(((revenue - (maintenanceCost + fuelCost)) / v.acquisition_cost).toFixed(3))
          : 0;
      return {
        regNo: v.reg_no,
        name: v.name,
        type: v.type,
        status: v.status,
        odometer: v.odometer,
        acquisitionCost: v.acquisition_cost,
        fuelCost,
        maintenanceCost,
        revenue,
        roi,
      };
    }),
  );
}

const REPORT_HEADERS = [
  'regNo', 'name', 'type', 'status', 'odometer',
  'acquisitionCost', 'fuelCost', 'maintenanceCost', 'revenue', 'roi',
];

async function reportCsv() {
  const rows = await vehicleReport();
  const escape = (val) => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [REPORT_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(REPORT_HEADERS.map((h) => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

analyticsRouter.get('/kpis', async (_req, res, next) => {
  try {
    res.json(await kpis());
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/reports', async (req, res, next) => {
  try {
    const format = req.query.format;
    if ((format ?? 'csv').toLowerCase() === 'csv') {
      const csv = await reportCsv();
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="transitops-vehicle-report.csv"');
      res.send(csv);
      return;
    }
    res.json(await vehicleReport());
  } catch (err) {
    next(err);
  }
});
