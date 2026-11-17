// Demo data: 4 role-mapped users + sample fleet. Same content as the old Prisma seed.
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

try { process.loadEnvFile(); } catch { /* rely on environment */ }

const demoUsers = [
  { email: 'manager@transitops.io', name: 'Fiona Fleet', role: 'FLEET_MANAGER', password: 'manager123' },
  { email: 'driver@transitops.io', name: 'Dave Driver', role: 'DRIVER', password: 'driver123' },
  { email: 'safety@transitops.io', name: 'Sam Safety', role: 'SAFETY_OFFICER', password: 'safety123' },
  { email: 'finance@transitops.io', name: 'Fay Finance', role: 'FINANCIAL_ANALYST', password: 'finance123' },
];

const daysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  console.log('Seeding database...');

  for (const u of demoUsers) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    // Refresh name/role/password on re-seed so credentials stay deterministic.
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role,
                                          password_hash = EXCLUDED.password_hash`,
      [randomUUID(), u.email, passwordHash, u.name, u.role],
    );
  }
  console.log(`Seeded ${demoUsers.length} demo users (role-mapped passwords)`);

  const vehicleData = [
    { regNo: 'TRK-001', name: 'Volvo FH16', type: 'Heavy Truck', maxLoadKg: 25000, odometer: 145000, acquisitionCost: 120000 },
    { regNo: 'TRK-002', name: 'Scania R500', type: 'Heavy Truck', maxLoadKg: 24000, odometer: 98000, acquisitionCost: 110000 },
    { regNo: 'VAN-101', name: 'Ford Transit', type: 'Van', maxLoadKg: 1500, odometer: 62000, acquisitionCost: 45000 },
    { regNo: 'VAN-102', name: 'Mercedes Sprinter', type: 'Van', maxLoadKg: 2000, odometer: 38000, acquisitionCost: 52000 },
    { regNo: 'TRK-003', name: 'MAN TGX', type: 'Heavy Truck', maxLoadKg: 26000, odometer: 210000, acquisitionCost: 130000 },
  ];
  const vehicles = [];
  for (const v of vehicleData) {
    const { rows } = await db.query(
      `INSERT INTO vehicles (id, reg_no, name, type, max_load_kg, odometer, acquisition_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (reg_no) DO NOTHING RETURNING id`,
      [randomUUID(), v.regNo, v.name, v.type, v.maxLoadKg, v.odometer, v.acquisitionCost],
    );
    if (rows[0]) vehicles.push(rows[0]);
    else {
      const existing = await db.query('SELECT id FROM vehicles WHERE reg_no = $1', [v.regNo]);
      vehicles.push(existing.rows[0]);
    }
  }
  console.log(`Seeded ${vehicles.length} vehicles`);

  const driverData = [
    { name: 'Marcus Reed', licenseNo: 'DL-88213', licenseCategory: 'CE', licenseExpiry: daysFromNow(400), contact: '+1-555-0101', safetyScore: 95 },
    { name: 'Elena Torres', licenseNo: 'DL-77410', licenseCategory: 'CE', licenseExpiry: daysFromNow(220), contact: '+1-555-0102', safetyScore: 88 },
    { name: 'Ravi Kumar', licenseNo: 'DL-66129', licenseCategory: 'C1', licenseExpiry: daysFromNow(-15), contact: '+1-555-0103', safetyScore: 72 },
    { name: 'Nina Petrov', licenseNo: 'DL-55098', licenseCategory: 'CE', licenseExpiry: daysFromNow(90), contact: '+1-555-0104', safetyScore: 90 },
  ];
  const drivers = [];
  for (const d of driverData) {
    const { rows } = await db.query(
      `INSERT INTO drivers (id, name, license_no, license_category, license_expiry, contact, safety_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (license_no) DO NOTHING RETURNING id`,
      [randomUUID(), d.name, d.licenseNo, d.licenseCategory, d.licenseExpiry, d.contact, d.safetyScore],
    );
    if (rows[0]) drivers.push(rows[0]);
    else {
      const existing = await db.query('SELECT id FROM drivers WHERE license_no = $1', [d.licenseNo]);
      drivers.push(existing.rows[0]);
    }
  }
  console.log(`Seeded ${drivers.length} drivers`);

  const { rows: tripCount } = await db.query('SELECT COUNT(*)::int AS c FROM trips');
  if (tripCount[0].c === 0) {
    const { rows: manager } = await db.query(`SELECT id FROM users WHERE email = 'manager@transitops.io'`);
    await db.query(
      `INSERT INTO trips (id, source, destination, vehicle_id, driver_id, created_by_id,
                          cargo_weight, planned_distance, final_odometer, fuel_consumed, revenue, status)
       VALUES ($1,'Chicago, IL','Detroit, MI',$2,$3,$4,18000,460,145460,155,4200,'COMPLETED')`,
      [randomUUID(), vehicles[0].id, drivers[0].id, manager[0]?.id ?? null],
    );
    await db.query(
      `INSERT INTO fuel_logs (id, vehicle_id, liters, cost) VALUES ($1,$2,155,250)`,
      [randomUUID(), vehicles[0].id],
    );
    await db.query(
      `INSERT INTO expenses (id, vehicle_id, category, amount) VALUES ($1,$2,'Tolls',85)`,
      [randomUUID(), vehicles[0].id],
    );
    console.log('Seeded sample trip + fuel + expense');
  }

  console.log('Seed complete.');
} finally {
  await db.end();
}
