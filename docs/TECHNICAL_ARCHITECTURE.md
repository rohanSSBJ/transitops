# TransitOps - Technical Architecture

> Smart Transport Operations Platform - a single system of record for the full
> lifecycle of transport operations: vehicle registry, driver management, trip
> dispatch, maintenance, fuel/expense tracking, and analytics - with business
> rules and RBAC enforced by the service layer, not by human discipline.

This document describes the **as-built** system: a plain-JavaScript
Express + node-postgres + PostgreSQL backend and a React (Vite) frontend.
It is the authoritative reference for engineers working on the codebase.

---

## 1. Overview

| Concern | Choice |
|---------|--------|
| Frontend | React 19 + TypeScript + Vite, Tailwind CSS, react-router, axios |
| API / business logic | Node.js + Express 4, plain JavaScript (ES modules) |
| Data access | Raw SQL via node-postgres (`pg`), parameterized queries, transactions |
| Database | PostgreSQL (schema in `server/db/schema.sql`) |
| Auth | JWT (jsonwebtoken) + bcrypt password hashing |
| Rate limiting | In-memory fixed window: 100 req/min global, 5 req/min on login |
| Reverse proxy (prod) | Any static host + `/api` reverse proxy to the API server |

**Separation guarantees**
- No SQL in the UI - the frontend only talks REST over JSON + JWT.
- Route modules contain validation, SQL and domain rules; shared middleware handles auth and errors.
- All SQL is parameterized - no string interpolation of user input.

---

## 2. System architecture

```mermaid
flowchart TB
  subgraph Client["Browser (SPA)"]
    UI["React + Vite<br/>pages / axios client / auth context"]
  end

  subgraph Host["Server host"]
    RP["Reverse proxy<br/>/ → static build · /api → :3000"]
    subgraph API["Express API :3000"]
      MW["Middleware<br/>CORS · rate limit · JWT auth · RBAC · validation"]
      R["Route modules<br/>state machines · rules · transactions"]
      DBL["pg Pool<br/>parameterized SQL"]
    end
    PG[("PostgreSQL<br/>constraints · indexes · FK rules")]
  end

  UI -- "HTTP/JSON + JWT" --> RP
  RP -- "/api/*" --> MW --> R --> DBL --> PG
  RP -- "/*" --> UI
```

Request flow: the browser calls `/api/...`; the proxy forwards to Express.
Middleware authenticates (JWT), authorizes (role gates), and validates
(whitelist validators), then route modules run the domain logic - multi-entity
mutations inside SQL transactions (BEGIN/COMMIT, ROLLBACK on error).

---

## 3. Module structure

```text
server/
├── db/
│   └── schema.sql               # entities, enums, indexes, relations (verbatim DDL)
├── scripts/
│   ├── migrate.js               # applies schema.sql to DATABASE_URL (fresh DB)
│   └── seed.js                  # 4 RBAC demo users + sample fleet data
├── src/
│   ├── index.js                 # entrypoint
│   ├── app.js                   # express app: CORS, throttle, routes, 404, errors
│   ├── config.js                # env configuration
│   ├── db.js                    # pg Pool + withTransaction helper
│   ├── lib/
│   │   ├── errors.js            # ApiError + status helpers
│   │   ├── validate.js          # whitelist validators (body/query)
│   │   ├── pagination.js        # page/limit/q/sort parsing + ORDER BY builder
│   │   └── mapper.js            # snake_case rows -> camelCase API payloads
│   ├── middleware/
│   │   ├── auth.js              # JWT authenticate + requireRoles
│   │   ├── rate-limit.js        # fixed-window per-IP limiter
│   │   └── error-handler.js     # status-code mapping (see §8)
│   └── routes/
│       ├── auth.js              # login, /me
│       ├── vehicles.js          # registry CRUD + status machine
│       ├── drivers.js           # profiles + license validity
│       ├── trips.js             # dispatch engine (core rules)
│       ├── maintenance.js       # open → IN_SHOP / close → AVAILABLE
│       ├── fuel-expenses.js     # fuel logs + expenses + cost rollups
│       ├── analytics.js         # KPIs + CSV export
│       └── health.js            # DB liveness probe
└── test/
    ├── api.test.js              # end-to-end API tests against a real database
    └── rate-limit.test.js       # login throttle behavior
```

---

## 4. Database design

Schema DDL lives in `server/db/schema.sql` and is unchanged from the original
Prisma-managed schema: 7 tables (`users`, `vehicles`, `drivers`, `trips`,
`maintenance_logs`, `fuel_logs`, `expenses`), 4 enum types (`Role`,
`VehicleStatus`, `DriverStatus`, `TripStatus`), unique constraints on
`users.email`, `vehicles.reg_no`, `drivers.license_no`, and foreign keys with
RESTRICT/CASCADE/SET NULL rules matching the domain invariants.

```mermaid
erDiagram
  User ||--o{ Trip : "creates (optional)"
  Vehicle ||--o{ Trip : "assigned to"
  Driver ||--o{ Trip : "assigned to"
  Vehicle ||--o{ MaintenanceLog : has
  Vehicle ||--o{ FuelLog : has
  Vehicle ||--o{ Expense : has
  Trip ||--o{ FuelLog : "optional link"
```

---

## 5. API surface

All endpoints are under `/api`. Unless noted, requests require
`Authorization: Bearer <jwt>`.

| Method | Path | Roles | Notes |
|--------|------|-------|-------|
| POST | `/api/auth/login` | public (5 req/min) | email + password → JWT |
| GET | `/api/auth/me` | any authenticated | current user profile |
| GET | `/api/health` | public | DB liveness probe |
| GET/POST | `/api/vehicles` | GET: any · POST: FLEET_MANAGER | list w/ pagination, search, filters |
| GET/PATCH/DELETE | `/api/vehicles/:id` | GET: any · write: FLEET_MANAGER | |
| GET/POST | `/api/drivers` | GET: any · POST: SAFETY_OFFICER, FLEET_MANAGER | |
| GET/PATCH/DELETE | `/api/drivers/:id` | GET: any · write: SAFETY_OFFICER, FLEET_MANAGER | |
| GET/POST | `/api/trips` | GET: any · POST: DRIVER, FLEET_MANAGER | create → DRAFT |
| POST | `/api/trips/:id/dispatch` | DRIVER, FLEET_MANAGER | DRAFT → DISPATCHED, vehicle+driver → ON_TRIP |
| POST | `/api/trips/:id/complete` | DRIVER, FLEET_MANAGER | records odometer/fuel, restores both |
| POST | `/api/trips/:id/cancel` | DRIVER, FLEET_MANAGER | DRAFT/DISPATCHED → CANCELLED |
| GET/POST | `/api/maintenance` | GET: any · POST: FLEET_MANAGER | open → vehicle IN_SHOP |
| POST | `/api/maintenance/:id/close` | FLEET_MANAGER | close → vehicle AVAILABLE (unless RETIRED) |
| GET/POST | `/api/fuel-logs` | GET: any · POST: FINANCIAL_ANALYST, FLEET_MANAGER | |
| GET/POST | `/api/expenses` | GET: any · POST: FINANCIAL_ANALYST, FLEET_MANAGER | |
| GET | `/api/expenses/rollup` | any authenticated | fuel + expense + maintenance totals |
| GET | `/api/analytics/kpis` | any authenticated | dashboard KPIs |
| GET | `/api/analytics/reports?format=json\|csv` | any authenticated | per-vehicle report / CSV export |

List endpoints accept `page` (default 1), `limit` (default 20, max 100),
`q` (case-insensitive search), `sort=field:asc|desc` (allowlisted fields),
plus endpoint-specific filters. Responses are
`{ data: [...], meta: { total, page, limit, totalPages } }`.

---

## 6. Core state machines

**Trip dispatch guards** (all violations → 422):
- only DRAFT trips can be dispatched
- vehicle must be AVAILABLE
- driver must be AVAILABLE (suspended drivers get a dedicated message)
- driver license must not be expired
- cargo weight must not exceed vehicle max load

Dispatch/complete/cancel group their writes inside SQL transactions.

**Maintenance side effects**: opening a record flips the vehicle to IN_SHOP
(rejected for ON_TRIP or RETIRED vehicles); closing restores AVAILABLE unless
the vehicle is RETIRED.

---

## 7. Analytics formulas

- `fleetUtilizationPct = onTrip / (totalVehicles - retired) × 100` (1 decimal)
- `fuelEfficiency = totalDistance / totalFuelConsumed` over completed trips (2 decimals)
- `operationalCost = fuelCost + maintenanceCost`
- `fleetRoi = (totalRevenue - operationalCost) / acquisitionCost` (3 decimals)
- alerts: expired licenses, licenses expiring within 30 days, open maintenance count

---

## 8. Error model

Every error response is JSON:
`{ statusCode, error, message, path, timestamp }`.

| Status | When |
|--------|------|
| 400 | validation failure (message is an array of reasons) |
| 401 | missing/invalid/expired token, bad credentials |
| 403 | role not permitted |
| 404 | record not found, unknown route |
| 422 | business-rule violation, unique/foreign-key constraint |
| 429 | rate limit exceeded |
| 503 | database unavailable |

---

## 9. Configuration

Environment variables (see `server/.env.example`):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | token signing secret |
| `JWT_EXPIRES_IN` | token lifetime (default `12h`) |
| `PORT` | API port (default `3000`) |
| `CORS_ORIGIN` | comma-separated allowed origins (default: reflect any) |

---

## 10. Testing

`server/test/api.test.js` runs end-to-end against a real PostgreSQL database:
it resets the data, then exercises auth, RBAC, every CRUD surface, the trip
state machine, maintenance side effects, rollups, analytics, validation and
error shapes. `server/test/rate-limit.test.js` covers the login throttle.

```bash
cd server
TEST_DATABASE_URL=postgresql://user:pass@host:5432/transitops_test npm test
```
