// snake_case row -> camelCase API object, matching the old Prisma payloads.
const pick = (row, pairs) => {
  const out = {};
  for (const [api, col] of pairs) {
    if (row[col] !== undefined) out[api] = row[col];
  }
  return out;
};

export const VEHICLE_PAIRS = [
  ['id', 'id'], ['regNo', 'reg_no'], ['name', 'name'], ['type', 'type'],
  ['maxLoadKg', 'max_load_kg'], ['odometer', 'odometer'],
  ['acquisitionCost', 'acquisition_cost'], ['status', 'status'],
  ['createdAt', 'created_at'],
];
export const DRIVER_PAIRS = [
  ['id', 'id'], ['name', 'name'], ['licenseNo', 'license_no'],
  ['licenseCategory', 'license_category'], ['licenseExpiry', 'license_expiry'],
  ['contact', 'contact'], ['safetyScore', 'safety_score'], ['status', 'status'],
  ['createdAt', 'created_at'],
];
export const TRIP_PAIRS = [
  ['id', 'id'], ['source', 'source'], ['destination', 'destination'],
  ['vehicleId', 'vehicle_id'], ['driverId', 'driver_id'],
  ['createdById', 'created_by_id'], ['cargoWeight', 'cargo_weight'],
  ['plannedDistance', 'planned_distance'], ['finalOdometer', 'final_odometer'],
  ['fuelConsumed', 'fuel_consumed'], ['revenue', 'revenue'], ['status', 'status'],
  ['createdAt', 'created_at'],
];
export const MAINTENANCE_PAIRS = [
  ['id', 'id'], ['vehicleId', 'vehicle_id'], ['type', 'type'], ['cost', 'cost'],
  ['notes', 'notes'], ['isOpen', 'is_open'], ['openedAt', 'opened_at'],
  ['closedAt', 'closed_at'],
];
export const FUEL_LOG_PAIRS = [
  ['id', 'id'], ['vehicleId', 'vehicle_id'], ['tripId', 'trip_id'],
  ['liters', 'liters'], ['cost', 'cost'], ['date', 'date'],
];
export const EXPENSE_PAIRS = [
  ['id', 'id'], ['vehicleId', 'vehicle_id'], ['category', 'category'],
  ['amount', 'amount'], ['date', 'date'],
];

export const mapRow = (pairs) => (row) => pick(row, pairs);
export const mapRows = (pairs) => (rows) => rows.map(pickRows(pairs));
function pickRows(pairs) {
  return (row) => pick(row, pairs);
}

export const mapVehicle = mapRow(VEHICLE_PAIRS);
export const mapDriver = mapRow(DRIVER_PAIRS);
export const mapTrip = mapRow(TRIP_PAIRS);
export const mapMaintenance = mapRow(MAINTENANCE_PAIRS);
export const mapFuelLog = mapRow(FUEL_LOG_PAIRS);
export const mapExpense = mapRow(EXPENSE_PAIRS);

/** Attach the nested vehicle/driver summaries the old Prisma include produced. */
export function withTripIncludes(trip, row) {
  return {
    ...trip,
    vehicle: { id: row.v_id, regNo: row.v_reg_no, name: row.v_name, status: row.v_status },
    driver: { id: row.d_id, name: row.d_name, licenseNo: row.d_license_no, status: row.d_status },
  };
}

export const TRIP_SELECT = `
  t.*,
  v.id AS v_id, v.reg_no AS v_reg_no, v.name AS v_name, v.status AS v_status,
  d.id AS d_id, d.name AS d_name, d.license_no AS d_license_no, d.status AS d_status
  FROM trips t
  JOIN vehicles v ON v.id = t.vehicle_id
  JOIN drivers d ON d.id = t.driver_id`;

export function mapTripRow(row) {
  return withTripIncludes(mapTrip(row), row);
}
