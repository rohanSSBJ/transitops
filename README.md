# TransitOps - Smart Transport Operations Platform

A centralized platform to manage the full lifecycle of transport operations -
vehicle registry, driver management, trip dispatch, maintenance, fuel/expense
tracking, and analytics - with business rules and RBAC enforced by the service
layer, not by human discipline.

The backend is plain JavaScript: Node.js + Express + raw SQL (node-postgres)
over PostgreSQL. A React (Vite) frontend talks to it over a JSON REST API.
See [`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) for the
full design.

---

## Tech stack

**Frontend** (`/`)
- React 19 + TypeScript + Vite
- Tailwind CSS (dark, glassy theme)
- react-router-dom, axios, motion (Framer Motion), lucide-react

**Backend** (`server/`)
- Node.js + Express 4 (plain JavaScript, no framework boilerplate or TypeScript)
- Raw SQL via node-postgres (`pg`) - no ORM
- JWT auth (jsonwebtoken) + bcrypt password hashing
- PostgreSQL 14+

---

## Getting started

### Frontend
```bash
npm install
npm run dev        # dev server (proxies /api -> local backend)
npm run build      # type-check + production build
npm run preview
```

### Backend
```bash
cd server
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET
npm run db:init               # create schema (fresh database)
npm run seed                  # 4 demo users + sample fleet
npm run dev                   # API on http://localhost:3000/api
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/transitops_test npm test
```

---

## Demo logins (RBAC)

Selecting a role on the login screen preselects its credentials.

| Role | Email | Password |
|------|-------|----------|
| Fleet Manager | `manager@transitops.io` | `manager123` |
| Driver | `driver@transitops.io` | `driver123` |
| Safety Officer | `safety@transitops.io` | `safety123` |
| Financial Analyst | `finance@transitops.io` | `finance123` |

---

## Routes

| Route | Description |
|-------|-------------|
| `/` | Marketing landing page |
| `/login` | Authentication (RBAC) - real JWT login |
| `/dashboard` | Operations dashboard - live KPIs, alerts, status breakdowns |
| `/fleet` | Vehicle registry - CRUD, lifecycle status, filters |
| `/drivers` | Drivers & safety profiles - license validity, safety scores, CRUD |
| `/trips` | Trip dispatcher - create → dispatch → complete/cancel, guards, live board |
| `/maintenance` | Maintenance - open/close records, IN_SHOP side effects |
| `/fuel-expenses` | Fuel & expense management - logs, cost rollups |
| `/analytics` | Reports & analytics - KPI formulas, charts, CSV export |
| `/settings` | Settings & RBAC - role matrix, security |

## Database safety and compatibility

`server/db/schema.sql` is the original schema DDL, unchanged. For an existing
compatible PostgreSQL database, configure `DATABASE_URL` and start the API.
Do not run `db:init` against it, and do not run the demo seed on production data.
`db:init` is only for a fresh empty database; the seed creates known demo logins.

Tests require a separate, disposable `TEST_DATABASE_URL` whose database name ends
in `_test`. They clear its application tables. They never inherit `DATABASE_URL`.
Initialize that disposable database with `db/schema.sql` before running tests.
Use Node.js 22 or newer. Set a real `JWT_SECRET`; there is no fallback signing key.
Demo credentials are for local demos only. Configure HTTPS, CORS and proxy trust
for your own deployment. This repository is source code, not a hosted deployment.
