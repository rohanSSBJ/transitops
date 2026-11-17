import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Never inherit the application database: tests reset data in a dedicated test DB.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable database ending in _test');
const testUrl = new URL(process.env.TEST_DATABASE_URL);
if (!decodeURIComponent(testUrl.pathname).endsWith('_test')) throw new Error('Test database name must end in _test');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_LOGIN = '1000';
process.env.RATE_LIMIT_GLOBAL = '100000';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');

let server;
let base;
const tokens = {};

before(async () => {
  // Reset to a known state: only the 4 role-mapped demo users.
  await pool.query(
    'TRUNCATE fuel_logs, expenses, maintenance_logs, trips, drivers, vehicles, users CASCADE',
  );
  const users = [
    ['manager@transitops.io', 'Fiona Fleet', 'FLEET_MANAGER', 'manager123'],
    ['driver@transitops.io', 'Dave Driver', 'DRIVER', 'driver123'],
    ['safety@transitops.io', 'Sam Safety', 'SAFETY_OFFICER', 'safety123'],
    ['finance@transitops.io', 'Fay Finance', 'FINANCIAL_ANALYST', 'finance123'],
  ];
  for (const [email, name, role, password] of users) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)',
      [email, hash, name, role],
    );
  }

  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function api(method, path, { token, body, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv etc. */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 201, `login ${email}: ${r.text}`);
  return r.json.accessToken;
}

test('health check', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.service, 'transitops-api');
});

test('login validation errors match old shapes', async () => {
  let r = await api('POST', '/api/auth/login', { body: { email: 'nope', password: 'manager123' } });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.json.message));
  assert.ok(r.json.message.includes('email must be an email'));

  r = await api('POST', '/api/auth/login', { body: { email: 'manager@transitops.io', password: 'x' } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.some((m) => m.includes('password must be longer than or equal to 6')));

  r = await api('POST', '/api/auth/login', { body: { email: 'manager@transitops.io', password: 'manager123', extra: 1 } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes('property extra should not exist'));

  r = await api('POST', '/api/auth/login', { body: { email: 'manager@transitops.io', password: 'wrong-password' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.message, 'Invalid credentials');
});

test('login all demo roles', async () => {
  tokens.manager = await login('manager@transitops.io', 'manager123');
  tokens.driver = await login('driver@transitops.io', 'driver123');
  tokens.safety = await login('safety@transitops.io', 'safety123');
  tokens.finance = await login('finance@transitops.io', 'finance123');
});

test('auth/me returns current user; bad token rejected', async () => {
  const r = await api('GET', '/api/auth/me', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.equal(r.json.email, 'manager@transitops.io');
  assert.equal(r.json.role, 'FLEET_MANAGER');
  assert.ok(r.json.createdAt);

  const bad = await api('GET', '/api/auth/me', { token: 'garbage' });
  assert.equal(bad.status, 401);

  const none = await api('GET', '/api/vehicles');
  assert.equal(none.status, 401);
});

let vehicleId; // main test truck
let vehicleB; // second vehicle for list/filter checks
test('vehicles: RBAC, create, validation, unique violation, update', async () => {
  let r = await api('POST', '/api/vehicles', { token: tokens.driver, body: { regNo: 'X', name: 'X', type: 'Van', maxLoadKg: 100 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.message, 'You do not have permission to perform this action');

  r = await api('POST', '/api/vehicles', { token: tokens.manager, body: { regNo: 'X', name: 'X', type: 'Van' } });
  assert.equal(r.status, 400);

  r = await api('POST', '/api/vehicles', { token: tokens.manager, body: { regNo: 'X', name: 'X', type: 'Van', maxLoadKg: -1 } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes('maxLoadKg must be greater than 0'));

  r = await api('POST', '/api/vehicles', { token: tokens.manager, body: { regNo: 'TST-100', name: 'Test Truck', type: 'Heavy Truck', maxLoadKg: 5000, acquisitionCost: 80000 } });
  assert.equal(r.status, 201, r.text);
  vehicleId = r.json.id;
  assert.equal(r.json.status, 'AVAILABLE');
  assert.equal(r.json.odometer, 0);

  r = await api('POST', '/api/vehicles', { token: tokens.manager, body: { regNo: 'TST-200', name: 'Test Van', type: 'Van', maxLoadKg: 1000, acquisitionCost: 30000 } });
  assert.equal(r.status, 201);
  vehicleB = r.json.id;

  r = await api('POST', '/api/vehicles', { token: tokens.manager, body: { regNo: 'TST-100', name: 'Dup', type: 'Van', maxLoadKg: 100 } });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Unique constraint failed on: regNo');

  r = await api('PATCH', `/api/vehicles/${vehicleId}`, { token: tokens.manager, body: { odometer: 1234 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.odometer, 1234);

  r = await api('PATCH', '/api/vehicles/nope', { token: tokens.manager, body: { odometer: 1 } });
  assert.equal(r.status, 404);
});

test('vehicles: list, pagination, filters, sort, search', async () => {
  let r = await api('GET', '/api/vehicles', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.total, 2);
  assert.ok(r.json.data[0].regNo);
  assert.ok('maxLoadKg' in r.json.data[0]);

  r = await api('GET', '/api/vehicles?limit=1&page=2', { token: tokens.manager });
  assert.equal(r.json.data.length, 1);
  assert.equal(r.json.meta.totalPages, 2);

  r = await api('GET', '/api/vehicles?q=truck', { token: tokens.manager });
  assert.equal(r.json.meta.total, 1);
  assert.equal(r.json.data[0].regNo, 'TST-100');

  r = await api('GET', '/api/vehicles?status=AVAILABLE', { token: tokens.manager });
  assert.equal(r.json.meta.total, 2);

  r = await api('GET', '/api/vehicles?type=van', { token: tokens.manager });
  assert.equal(r.json.meta.total, 1);

  r = await api('GET', '/api/vehicles?sort=regNo:desc', { token: tokens.manager });
  assert.equal(r.json.data[0].regNo, 'TST-200');

  r = await api('GET', '/api/vehicles?sort=bogus:asc', { token: tokens.manager });
  assert.equal(r.status, 200); // falls back to default order

  r = await api('GET', '/api/vehicles?status=BOGUS', { token: tokens.manager });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.some((m) => m.includes('status must be one of the following values')));

  r = await api('GET', '/api/vehicles?page=abc', { token: tokens.manager });
  assert.equal(r.status, 400);

  r = await api('GET', '/api/vehicles?foo=bar', { token: tokens.manager });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes('property foo should not exist'));

  r = await api('GET', '/api/vehicles/not-a-real-id', { token: tokens.manager });
  assert.equal(r.status, 404);
  assert.equal(r.json.message, 'Vehicle not found');
});

let driverId;
test('drivers: RBAC, create, validation, update', async () => {
  let r = await api('POST', '/api/drivers', { token: tokens.finance, body: {} });
  assert.equal(r.status, 403);

  r = await api('POST', '/api/drivers', { token: tokens.safety, body: { name: 'Test Driver', licenseNo: 'DL-TST1', licenseCategory: 'CE', licenseExpiry: 'not-a-date' } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.some((m) => m.includes('licenseExpiry must be a valid ISO 8601 date string')));

  r = await api('POST', '/api/drivers', { token: tokens.safety, body: { name: 'Test Driver', licenseNo: 'DL-TST1', licenseCategory: 'CE', licenseExpiry: '2030-01-01' } });
  assert.equal(r.status, 201, r.text);
  driverId = r.json.id;
  assert.equal(r.json.safetyScore, 100);

  r = await api('PATCH', `/api/drivers/${driverId}`, { token: tokens.safety, body: { safetyScore: 88 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.safetyScore, 88);

  r = await api('PATCH', `/api/drivers/${driverId}`, { token: tokens.safety, body: { safetyScore: 500 } });
  assert.equal(r.status, 400);

  r = await api('GET', '/api/drivers?q=dl-tst1', { token: tokens.manager });
  assert.equal(r.json.meta.total, 1);
});

let tripId;
test('trips: create, dispatch, complete lifecycle with side effects', async () => {
  let r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId: '00000000-0000-0000-0000-000000000000', driverId, cargoWeight: 100, plannedDistance: 10 } });
  assert.equal(r.status, 404, r.text);
  assert.equal(r.json.message, 'Vehicle not found');

  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId: 'not-uuid', driverId, cargoWeight: 100, plannedDistance: 10 } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.some((m) => m.includes('vehicleId must be a UUID')));

  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId, cargoWeight: -5, plannedDistance: 10 } });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes('cargoWeight must be >= 0'));

  // overweight cargo: create ok, dispatch blocked
  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId, cargoWeight: 99999, plannedDistance: 10 } });
  assert.equal(r.status, 201, r.text);
  const fatTrip = r.json.id;
  assert.equal(r.json.status, 'DRAFT');
  assert.equal(r.json.vehicle.regNo, 'TST-100');
  assert.equal(r.json.driver.licenseNo, 'DL-TST1');
  r = await api('POST', `/api/trips/${fatTrip}/dispatch`, { token: tokens.manager });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Cargo weight (99999kg) exceeds vehicle max load (5000kg)');
  await api('POST', `/api/trips/${fatTrip}/cancel`, { token: tokens.manager });

  // normal lifecycle
  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'Hubli', destination: 'Pune', vehicleId, driverId, cargoWeight: 1000, plannedDistance: 430, revenue: 9000 } });
  assert.equal(r.status, 201);
  tripId = r.json.id;

  r = await api('POST', `/api/trips/${tripId}/dispatch`, { token: tokens.manager });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'DISPATCHED');
  assert.equal(r.json.vehicle.status, 'ON_TRIP');
  assert.equal(r.json.driver.status, 'ON_TRIP');

  r = await api('POST', `/api/trips/${tripId}/dispatch`, { token: tokens.manager });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Only DRAFT trips can be dispatched (current: DISPATCHED)');

  r = await api('POST', `/api/trips/${tripId}/complete`, { token: tokens.manager, body: { finalOdometer: 5000, fuelConsumed: 120 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'COMPLETED');
  assert.equal(r.json.revenue, 9000); // kept original revenue
  assert.equal(r.json.vehicle.status, 'AVAILABLE');

  // vehicle odometer updated as a side effect (odometer is not in the trip payload)
  const v = await api('GET', `/api/vehicles/${vehicleId}`, { token: tokens.manager });
  assert.equal(v.json.odometer, 5000);
  assert.equal(v.json.status, 'AVAILABLE');

  r = await api('POST', `/api/trips/${tripId}/complete`, { token: tokens.manager, body: { finalOdometer: 1, fuelConsumed: 1 } });
  assert.equal(r.status, 422);
  assert.ok(r.json.message.includes('Only DISPATCHED trips can be completed'));

  r = await api('POST', `/api/trips/${tripId}/cancel`, { token: tokens.manager });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Cannot cancel a COMPLETED trip');

  // filters
  r = await api('GET', `/api/trips?status=COMPLETED&vehicleId=${vehicleId}`, { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.ok(r.json.meta.total >= 1);
  assert.ok(r.json.data.every((t) => t.status === 'COMPLETED'));
});

test('trips: dispatched-trip cancel restores vehicle and driver', async () => {
  let r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId, cargoWeight: 10, plannedDistance: 10 } });
  const id = r.json.id;
  await api('POST', `/api/trips/${id}/dispatch`, { token: tokens.manager });
  r = await api('POST', `/api/trips/${id}/cancel`, { token: tokens.manager });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, 'CANCELLED');
  assert.equal(r.json.vehicle.status, 'AVAILABLE');
  assert.equal(r.json.driver.status, 'AVAILABLE');

  r = await api('POST', `/api/trips/${id}/cancel`, { token: tokens.manager });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Cannot cancel a CANCELLED trip');
});

test('trips: expired license and suspended driver block dispatch', async () => {
  let r = await api('POST', '/api/drivers', { token: tokens.safety, body: { name: 'Old License', licenseNo: 'DL-OLD1', licenseCategory: 'CE', licenseExpiry: '2020-01-01' } });
  assert.equal(r.status, 201, r.text);
  const expiredDriver = r.json.id;

  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId: expiredDriver, cargoWeight: 10, plannedDistance: 10 } });
  assert.equal(r.status, 201);
  let d = await api('POST', `/api/trips/${r.json.id}/dispatch`, { token: tokens.manager });
  assert.equal(d.status, 422);
  assert.equal(d.json.message, 'Driver license has expired');
  await api('POST', `/api/trips/${r.json.id}/cancel`, { token: tokens.manager });

  // suspended driver
  await api('PATCH', `/api/drivers/${driverId}`, { token: tokens.safety, body: { status: 'SUSPENDED' } });
  r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId, cargoWeight: 10, plannedDistance: 10 } });
  d = await api('POST', `/api/trips/${r.json.id}/dispatch`, { token: tokens.manager });
  assert.equal(d.status, 422);
  assert.equal(d.json.message, 'Driver is suspended');
  await api('POST', `/api/trips/${r.json.id}/cancel`, { token: tokens.manager });
  await api('PATCH', `/api/drivers/${driverId}`, { token: tokens.safety, body: { status: 'AVAILABLE' } });
});

let maintId;
test('maintenance: open/close with vehicle status side effects', async () => {
  let r = await api('POST', '/api/maintenance', { token: tokens.driver, body: {} });
  assert.equal(r.status, 403);

  r = await api('POST', '/api/maintenance', { token: tokens.manager, body: { vehicleId, type: 'Oil change', cost: 150 } });
  assert.equal(r.status, 201, r.text);
  maintId = r.json.id;
  assert.equal(r.json.isOpen, true);
  assert.equal(r.json.cost, 150);

  let v = await api('GET', `/api/vehicles/${vehicleId}`, { token: tokens.manager });
  assert.equal(v.json.status, 'IN_SHOP');

  r = await api('POST', `/api/maintenance/${maintId}/close`, { token: tokens.manager, body: { notes: 'done' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.isOpen, false);
  assert.equal(r.json.cost, 150); // kept
  assert.equal(r.json.notes, 'done');
  assert.ok(r.json.closedAt);

  v = await api('GET', `/api/vehicles/${vehicleId}`, { token: tokens.manager });
  assert.equal(v.json.status, 'AVAILABLE');

  r = await api('POST', `/api/maintenance/${maintId}/close`, { token: tokens.manager, body: {} });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Maintenance record is already closed');

  r = await api('GET', `/api/maintenance?isOpen=false&vehicleId=${vehicleId}`, { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.length >= 1);
  assert.equal(r.json.data[0].vehicle.regNo, 'TST-100');

  r = await api('GET', '/api/maintenance?isOpen=maybe', { token: tokens.manager });
  assert.equal(r.status, 400);
  assert.ok(r.json.message.includes('isOpen must be a boolean string'));
});

test('maintenance: ON_TRIP vehicle cannot go into the shop', async () => {
  let r = await api('POST', '/api/trips', { token: tokens.manager, body: { source: 'A', destination: 'B', vehicleId, driverId, cargoWeight: 10, plannedDistance: 10 } });
  const id = r.json.id;
  await api('POST', `/api/trips/${id}/dispatch`, { token: tokens.manager });
  r = await api('POST', '/api/maintenance', { token: tokens.manager, body: { vehicleId, type: 'Brakes' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Cannot open maintenance on a vehicle that is ON_TRIP');
  await api('POST', `/api/trips/${id}/cancel`, { token: tokens.manager });
});

test('fuel logs and expenses: RBAC, create, rollup math, FK violation', async () => {
  let r = await api('POST', '/api/fuel-logs', { token: tokens.safety, body: {} });
  assert.equal(r.status, 403);

  r = await api('POST', '/api/fuel-logs', { token: tokens.finance, body: { vehicleId, liters: 50, cost: 100 } });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.date);

  r = await api('POST', '/api/fuel-logs', { token: tokens.finance, body: { vehicleId, tripId: '00000000-0000-0000-0000-000000000000', liters: 1, cost: 1 } });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Related record constraint failed');

  r = await api('POST', '/api/expenses', { token: tokens.finance, body: { vehicleId, category: 'Tolls', amount: 40 } });
  assert.equal(r.status, 201);

  r = await api('GET', `/api/expenses/rollup?vehicleId=${vehicleId}`, { token: tokens.finance });
  assert.equal(r.status, 200);
  assert.equal(r.json.fuelCost, 100);
  assert.equal(r.json.expenseCost, 40);
  assert.equal(r.json.maintenanceCost, 150);
  assert.equal(r.json.operationalCost, 250);
  assert.equal(r.json.totalCost, 290);

  r = await api('GET', `/api/fuel-logs?vehicleId=${vehicleId}`, { token: tokens.manager });
  assert.equal(r.json.meta.total, 1);
  assert.equal(r.json.data[0].vehicle.regNo, 'TST-100');

  r = await api('GET', '/api/expenses?q=tolls', { token: tokens.manager });
  assert.ok(r.json.meta.total >= 1);
});

test('analytics: kpis, json report, csv export', async () => {
  let r = await api('GET', '/api/analytics/kpis', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.fleetUtilizationPct, 'number');
  assert.equal(r.json.counts.vehicles.total, 2);
  assert.ok(r.json.counts.trips.byStatus.COMPLETED >= 1);
  assert.equal(r.json.alerts.expiredLicenses, 1);
  assert.ok(r.json.totalRevenue >= 9000);

  r = await api('GET', '/api/analytics/reports?format=json', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  const row = r.json.find((x) => x.regNo === 'TST-100');
  assert.equal(row.fuelCost, 100);
  assert.equal(row.revenue, 9000);

  r = await api('GET', '/api/analytics/reports', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /transitops-vehicle-report\.csv/);
  assert.ok(r.text.startsWith('regNo,name,type,status,odometer,acquisitionCost,fuelCost,maintenanceCost,revenue,roi'));

  r = await api('GET', '/api/analytics/kpis'); // no token
  assert.equal(r.status, 401);
});

test('unknown route and malformed JSON', async () => {
  const r = await api('GET', '/api/nope', { token: tokens.manager });
  assert.equal(r.status, 404);
  assert.equal(r.json.message, 'Cannot GET /api/nope');

  const bad = await api('POST', '/api/auth/login', { raw: '{invalid json' });
  assert.equal(bad.status, 400);
});

test('vehicle delete blocked by existing trips (FK restrict)', async () => {
  const r = await api('DELETE', `/api/vehicles/${vehicleId}`, { token: tokens.manager });
  assert.equal(r.status, 422);
  assert.equal(r.json.message, 'Related record constraint failed');
});

test('driver delete works and returns deleted flag', async () => {
  let r = await api('POST', '/api/drivers', { token: tokens.safety, body: { name: 'Temp', licenseNo: 'DL-TMP1', licenseCategory: 'C1', licenseExpiry: '2031-01-01' } });
  const id = r.json.id;
  r = await api('DELETE', `/api/drivers/${id}`, { token: tokens.safety });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: true, id });
});
