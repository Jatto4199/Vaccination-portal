# Vaccination Registry

A web-based, offline-first patient registry and automated vaccination scheduling portal for rural maternal and child health clinics.

Health workers register mothers and children, record vaccinations and see who is due, upcoming or overdue, **with or without an internet connection**. Each clinic (node) keeps a local copy of its patients' records. When a connection is available, changes synchronize with a central PostgreSQL server, and conflicts between clinics are resolved by explicit rules.

## Quick start

Requires **Node.js 22.12 or later** (24 recommended). You don't need to install a database.

```bash
npm install
npm run dev
```

Open http://localhost:5173. On the first run the server:
- creates `.env` with a random `JWT_SECRET`;
- creates an embedded PostgreSQL database (PGlite) in `server/data/pgdata`;
- fills it with demo data.

### Demo accounts

All demo accounts use the password **`1234567890`**. It is also the default temporary password for new users and password resets.

| Username | Role | Clinic |
|---|---|---|
| `admin` | Administrator | All clinics |
| `nurse1`, `chew1` | Health worker | CLN01 Iloro PHC |
| `nurse2`, `chew2` | Health worker | CLN02 Oke-Ode PHC |
| `nurse3`, `chew3` | Health worker | CLN03 Ajasse PHC |

You can also log in with the email address, for example `nurse1@example.org`.

**Demo data:**
- About 65 patients: children aged 0–24 months, plus mothers on maternal Td.
- About 500 vaccination records, simulated relative to today. Most families attend on time, some come late, and some stop coming. Every clinic therefore has vaccinations due today, upcoming and overdue.
- One duplicate patient registered at two clinics, waiting in the admin's conflict queue.

All people, phone numbers (`0800…`) and clinics are fictional.

### Useful commands

```bash
npm test                 # scheduling engine + sync protocol tests (embedded PostgreSQL)
npm run build            # build the web app (PWA)
npm start                # production server on :4000, serves the built app
npm run db:seed          # add demo data to an empty database
npm run db:reset -- --yes  # DELETE ALL DATA and recreate the demo data
```

To run the tests against a real PostgreSQL server, set `TEST_DATABASE_URL=postgres://…`. This **wipes** that database's `public` schema.

## About the JWT_SECRET message

`JWT_SECRET` is the key that signs login tokens. Anyone who knows it can create a valid login, so it must be private and random.

- **Locally:** `npm run dev` creates `.env` with a random secret the first time. `.env` is git-ignored and must never be committed.
- **On Vercel:** set it yourself (see below). The server refuses to start in production without it.

## Deploying: GitHub, then Vercel

### 1. Push to GitHub

Create an **empty** repository on github.com (no README or licence), then:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

### 2. Create the Vercel project

1. On vercel.com: **Add New → Project**, then import the GitHub repository. Leave the build settings as they are; `vercel.json` configures them.
2. **Add a database:** in the project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL` automatically.
3. **Set environment variables** under **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `JWT_SECRET` | output of `openssl rand -hex 32` |
| `CRON_SECRET` | output of `openssl rand -hex 32` (protects the daily reminder job) |
| `SEED_DEMO_DATA` | `true` for a demo deployment (fills the empty database on first request); leave unset for real use |
| `SEED_ADMIN_PASSWORD`, `SEED_STAFF_PASSWORD` | optional: passwords for the demo accounts instead of the default `1234567890` |

4. **Deploy** (or redeploy after adding the variables). Open the site and log in.

Alternatively, seed the hosted database from your computer:

```bash
DATABASE_URL="<neon connection string>" npm run db:seed
```

**What runs where on Vercel:**
- The web app is served as static files from `client/dist`.
- The API runs as one serverless function (`api/index.js`).
- Vercel Cron calls `/api/cron/daily` every day at 06:00 UTC to refresh schedules and send SMS reminders.

> **Security note:** every account starts with the password `1234567890`, so anyone who has read this README can log in to your deployment, including as `admin`. That's fine for a demo with fictional data. Before using it with real patients, give every account its own password (admin → Users → Reset password).

## How the implementation maps to Chapter 3

### 3.5 Components

| Module | Implementation |
|---|---|
| 1. User Management | `server/src/auth.js`, `server/src/routes/admin.js`, `client/src/pages/admin/Users.jsx` |
| 2. Patient Registration | `client/src/pages/PatientForm.jsx`, `registerPatient()` in `client/src/repo.js` |
| 3. Guardian Management | guardian section of the registration form; `guardians` table |
| 4. Vaccination Management | `client/src/pages/Patient.jsx` (record, void), `vaccination_records` table |
| 5. Vaccination Scheduling Engine | `shared/schedule.js` (used on nodes and server), `shared/schedule-data.js` |
| 6. Reminder and Notification | `client/src/schedules.js` + Notifications page (health workers); `server/src/reminders.js` (SMS to guardians) |
| 7. Local Storage | `client/src/db.js` (IndexedDB via Dexie) |
| 8. Synchronization | `client/src/sync.js` (node), `server/src/sync.js` (central server) |
| 9. Conflict Resolution | `server/src/sync.js`, `client/src/pages/admin/Conflicts.jsx` |
| 10. Reporting and Administrative | `client/src/pages/Reports.jsx`, `client/src/pages/admin/` |

### 3.7 Architecture layers

- **Presentation layer** (3.7.1): `client/src/pages/`. It has the login page, dashboard, patient registration, patient search, vaccination history, vaccination schedule, upcoming, overdue, notifications and administration screens.
- **Application layer** (3.7.2):
  - `shared/` holds the business rules: scheduling, statuses and conflict-relevant field definitions.
  - `client/src/repo.js`, `schedules.js` and `sync.js` handle node-side processing.
  - `server/src/` handles authorization, synchronization and conflict processing.
- **Local data layer** (3.7.3): IndexedDB on each node. Every change is saved locally first.
- **Synchronization layer** (3.7.4): push/pull protocol between `client/src/sync.js` and `server/src/sync.js`. It covers change detection, packaging, transmission, receiving, conflict detection and resolution, confirmation, and retry with increasing delays.

### 3.12 Database entities (`server/src/db.js`)

| Entity | Table | Notes |
|---|---|---|
| User | `users` | username, email, password hash (scrypt), role, clinic, account status, date created |
| Clinic | `clinics` | name, location, contact, **node identifier**, **synchronization status**, last sync |
| Patient | `patients` | patient number, name, date of birth, sex, address, guardian, clinic, registration date |
| Guardian | `guardians` | name, relationship, telephone, address, identification number, preferred notification method, SMS consent. A mother's guardian record is her own contact profile (`patient_id`) |
| Vaccine | `vaccines` | one row per dose: name, dose number, recommended age, recommended interval, status. Also min/max age, needed for catch-up scheduling |
| Vaccination Record | `vaccination_records` | patient, vaccine, dose, date administered, health worker, clinic, record status (valid/voided) |
| Vaccination Schedule | `vaccination_schedules` | expected due date, actual administration date, status, last updated. **Stored on every node and on the server** |
| Synchronization Record | `sync_records` | record, node, change type, version number, timestamp, sync status, conflict status. On nodes it is also the outbox of pending changes |

Supporting tables:
- `record_versions`: full history of every record version, used for field-level conflict detection.
- `conflicts`: conflicts waiting for or after review.
- `notifications`: SMS reminders sent.
- `audit_log`, `settings`, `counters`.

### 3.6.1 Functional requirements

| # | Requirement | Where |
|---|---|---|
| 1–3 | Login, user accounts, roles and permissions | `auth.js`, admin Users page, `requireRole` |
| 4–6 | Register mothers and children; demographic, contact and guardian information | Registration form |
| 7–8 | Vaccination records and history | Patient → Vaccination schedule / history |
| 9–13 | Automatic schedules, due dates, upcoming, overdue, catch-up | `shared/schedule.js`; Upcoming and Overdue pages |
| 14 | Reminders for upcoming or missed vaccinations | Notifications page (health workers), SMS reminders (guardians) |
| 15 | Store records locally when offline | IndexedDB; PWA service worker for the app itself |
| 16 | Detect network availability | `isServerReachable()` checks the server answers, not just Wi-Fi |
| 17 | Synchronize when connectivity is restored | Sync on reconnect, every minute, after each change; retry with backoff |
| 18–19 | Detect conflicts; apply conflict rules | Version comparison and field-level merge in `server/src/sync.js` |
| 20 | Audit trail | `audit_log` (logins, patient and vaccination changes, sync, admin actions) |
| 21 | Search patient records | Patient search (local), plus "Search all clinics" when online |
| 22 | Administrative and vaccination reports | Reports page, admin Clinics, Sync log and Audit log |

### 3.14 Conflict rules

| Situation | Rule |
|---|---|
| Different fields changed at two clinics | Merged automatically |
| Same non-critical field (address, phone, name) | Version/timestamp rule: the last change received wins; the overwritten value is logged |
| Same critical field (date of birth, sex, patient type) | Server value kept; flagged for administrative review |
| Vaccination records | Auditable and append-only: voided with a reason, never overwritten |
| Same dose recorded twice | Both kept; flagged for review |
| Likely duplicate patient (same name and date of birth, or same guardian phone) | Flagged; the administrator can merge the two records |

### 3.15 Security

| Requirement | Implementation |
|---|---|
| Authentication | Hashed passwords (scrypt on the server, PBKDF2 for offline login on the node) |
| Role-based access | Health worker and administrator roles, enforced by the server |
| Secure communication | HTTPS (provided by Vercel) |
| Auditability | Every action listed in 3.15.4 is logged |
| Session management | Sessions end when the app is closed and after inactivity (configurable); offline login expires after a configurable number of days |

## Design decisions to explain in the thesis

- **Hub-and-spoke synchronization.** Chapter 3 allows syncing "with the central aggregation layer, or with other participating nodes". This implementation uses the central server. Direct node-to-node sync is future work.
- **Server order, not device clocks.** Each accepted change gets the next `server_seq`. Nodes pull everything after the last number they saw, so wrong clocks on cheap devices can't reorder changes.
- **Every sync is safe to retry.** Each change has a `change_id`, and the server stores the result in `sync_records`.
- **IDs are created offline without collisions.** They are UUIDs, and patient numbers follow the form `CLN01-3F2A-0007` (clinic code, device code, counter).
- **Schedules are derived data.** Each node regenerates its own `vaccination_schedules` from synced records, and refreshes them daily. They are never synced themselves, so they can't conflict.

## Limitations and future work

- **Peer-to-peer sync** between clinics is not implemented (see above).
- **Local data is not encrypted at rest.** On-device records are protected by login, session expiry and idle logout. Encrypting IndexedDB is future work.
- **SMS is simulated.** Messages are logged by the server. To use a gateway such as Africa's Talking or Termii, replace `send()` in `server/src/reminders.js`.
- **Verify the schedule template.** `shared/schedule-data.js` follows the commonly published Nigerian routine immunization schedule and **must be checked against the current official NPHCDA schedule** before real use. Administrators can edit it under Configuration.
- **Data held on each node:** a node stores its own clinic's patients plus visiting patients it has served or added through "Search all clinics".

## Project structure

```
shared/        scheduling engine, vaccine template, settings, sync table definitions (+ tests)
server/src/    Express API, PostgreSQL schema, sync protocol, schedules, reminders, demo seeder
server/test/   end-to-end tests of the API and sync protocol
client/src/    React PWA: IndexedDB, sync engine, schedules, screens
api/index.js   Vercel serverless entry point
vercel.json    Vercel build, routing and cron configuration
```
