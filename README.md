# Slotbook

Hosts publish availability, guests book slots, nobody is double-booked. TypeScript + Hono + Postgres 16. No Redis: Postgres row locks decide every race.

## Run it (Option A: one command, needs Docker Desktop)
```bash
docker compose up --build
```
First run takes a few minutes. When you see `Slotbook on http://localhost:3000`, open:
- Home page: http://localhost:3000/
- Host profile (all event types): http://localhost:3000/demo
- Guest booking page: http://localhost:3000/demo/intro-30  (group session: /demo/workshop-60)
- Host dashboard: http://localhost:3000/host  (login `demo@slotbook.dev` / `demo1234`)
- Health: http://localhost:3000/health
Stop with Ctrl+C; reset all data with `docker compose down -v`.

### If Docker says "lookup auth.docker.io: no such host"
That is your internet/DNS, not the project. Try: open https://hub.docker.com in a browser; set Windows DNS to 8.8.8.8 / 1.1.1.1; restart Docker Desktop (`wsl --shutdown` first); turn off VPN/proxy or use a phone hotspot. Or use Option B below.

## Run it with no Docker and no local Postgres (Option C: Supabase)
1. Create a free project at supabase.com. In **SQL Editor**, run `migrations/001_init.sql`, then `migrations/002_seed.sql`.
2. Project **Settings > Database > Connection string > URI**; replace the password. If the direct host fails on your network, use the "Session pooler" string.
3. `npm install`, then (PowerShell) `$env:PGSSL="1"; $env:DATABASE_URL="postgresql://...postgres"; npm start`. Leave `?sslmode=...` out of the URL.
Do not run `npm test` against this database: tests delete bookings.

## Run it (Option B: your own Postgres + Node 18+)
Windows shortcut (after installing Node LTS and PostgreSQL, remembering the postgres password you chose):
`powershell -ExecutionPolicy Bypass -File .\scripts\run-local.ps1 -PgPassword YOUR_PASSWORD`
Manual steps:
```bash
createdb slotbook && psql slotbook < migrations/001_init.sql && psql slotbook < migrations/002_seed.sql
npm install
DATABASE_URL=postgres://USER:PASS@localhost:5432/slotbook npm start
```
(Windows PowerShell: `$env:DATABASE_URL="..."; npm start`.)

## Tests (real Postgres, no mocks)
```bash
docker compose up -d db && npm install
DATABASE_URL=postgres://postgres:slot@localhost:5433/slotbook npm test
```
Covers: 100 parallel holds -> exactly 1 wins; group capacity 5 under 40 parallel holds; idempotent holds; expiry and cancel free capacity; reschedule collision rolls back; notifications written; DST (New York, 2026-03-08); min notice / horizon; day-off override.

Browser e2e: start the app (`RATE_LIMIT=1000000 npm start`), then `npx playwright install chromium && npm run e2e`.
Load test: with the app running and `RATE_LIMIT=1000000`, `VUS=20 SECS=10 npm run loadtest` prints throughput, p95 and error rate.
CI: `.github/workflows/ci.yml` runs typecheck, integration tests and e2e on every push.

## Embed on any website
Host dashboard > Event types > "Copy embed" gives `<iframe src=".../demo/intro-30?embed=1" width="100%" height="720" style="border:0"></iframe>`.

## 60-second tour
1. Open /host, sign in. Change time zone, add an event type, edit weekly windows (`Mon 09:00-13:00`) and overrides (`2026-12-25 off`), Save.
2. Open /demo/intro-30. Switch the time zone, pick a slot (held 5 min, countdown shown), enter name + email, Confirm.
3. Open the private manage link to reschedule or cancel. Back on /host see the booking, cancel it with a reason, and read the notifications feed.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | /api/hosts/{host}/events/{slug} | Event info (id, duration, host) |
| GET | /api/hosts/{host}/events/{slug}/slots?from&to&tz | Available slots (UTC `start`, `local` in tz, `remaining`) |
| POST | /api/holds | Body `{eventTypeId,start}`, header `Idempotency-Key` required. 409 slot full, 422 not offered |
| POST | /api/holds/{id}/confirm | Body `{name,email}` -> booking + `manage_token`. 410 if expired |
| GET | /api/bookings/{token} | View booking |
| POST | /api/bookings/{token}/reschedule | Body `{start}`; atomic, old slot kept on 409 |
| POST | /api/bookings/{token}/cancel | Body `{reason}`; idempotent |
| POST | /api/auth/login | `{email,password}` -> Bearer token |
| GET/PUT | /api/host/me | Profile / home IANA time zone |
| GET/POST | /api/host/event-types | List / create |
| GET/PUT | /api/host/availability | Weekly rules + date overrides |
| GET | /api/host/bookings, /api/host/notifications | Upcoming bookings, notification feed |
| POST | /api/host/bookings/{id}/cancel | Host cancels with reason |
| GET | /health, /metrics | Liveness + DB check; booking counts, hold expiries, notification lag |

## How correctness works
Every write transaction first locks the host row (`SELECT ... FOR UPDATE`), then checks capacity (held + confirmed at the same start) and buffered overlap with other bookings, then inserts. Writers for one host are serialised, so races cannot double-book. Holds expire at read time (`hold_expires_at > now()`), so no cron job is needed. The idempotency key is read after the lock. Notifications are rows written in the same transaction as the state change.

## Assumptions
Slot step = event duration. Host login is a seeded email/password (signed 24h token). Notifications sink is the `notifications` table. UI is plain HTML/JS served by the API. Extensions built: daily cap + per-guest limit, abuse protection (rate limit), observability (JSON logs, /health, /metrics), embeddable widget, Playwright e2e + GitHub Actions CI, load-test script, keyboard-operable UI. Not built: waitlist, reminders, .ics, webhooks, round-robin, calendar import, live deployment. See REQUIREMENTS.md for the full checklist.
Report deck: docs/Slotbook_Report.pptx. AI usage: AI_LOG.md.
