# Requirements checklist (brief vs. implementation)
Status: Done / Partial / Not built.

| Requirement | Status | Where / proof |
|---|---|---|
| Host home time zone (IANA, validated) | Done | /host > Settings; PUT /api/host/me |
| Event types: slug, duration 15-120, capacity, buffers 0-30, min notice, horizon | Done | DB CHECK constraints; /host > Event types |
| Weekly availability, several windows/day, date overrides (day off / custom hours) | Done | /host > Availability; test/slots.test.ts |
| Host sees upcoming bookings, cancels with a reason | Done | /host > Bookings |
| Guest page /{host}/{event}, 30-day slots, browser TZ + switcher | Done | public/book.html |
| 5-minute hold while entering details | Done | createHold; countdown in UI |
| Confirm + private manage link; reschedule; cancel | Done | /manage/{token}; e2e test |
| Lifecycle held > confirmed > cancelled; lapsed holds become expired | Done | expiry swept every 5 s + read-time rule; sweeper test |
| Capacity counts holds + confirmed, never expired/cancelled | Done | ACTIVE predicate; concurrency tests |
| Notifications on confirm / reschedule / cancel | Done | notifications table, host feed, lag in /metrics |
| API (5 endpoints) documented; Idempotency-Key on holds | Done | README; idempotency test |
| No double booking under concurrency | Done | host row lock; 100-way race test; load test max 5 on cap-5 slot |
| Postgres only (no Redis) | Done | |
| One command run + migrations + seed (2 event types) | Done* | `docker compose up --build` (*Docker path not executed in my sandbox; logic verified on Postgres 16) |
| Tests incl. concurrency vs real Postgres | Done | `npm test` (12 tests) |
| README, AI_LOG.md, full history, report | Partial | README/AI_LOG/report included; you must commit history yourself (no squash) and edit AI_LOG |
| Ext: daily cap + per-guest limit | Done | tests |
| Ext: abuse protection (rate limits) | Partial | in-memory per-IP limit; no bot/CAPTCHA |
| Ext: observability | Done | JSON logs + request IDs, /health, /metrics |
| Ext: load test | Done | scripts/loadtest.mjs (241 req/s, p95 145 ms locally) |
| Ext: e2e tests + CI | Done | e2e/guest.spec.ts, .github/workflows/ci.yml (CI not yet run on GitHub) |
| Ext: embeddable widget | Done | ?embed=1 + copy-embed button |
| Ext: accessibility | Partial | keyboard-operable calendar, labels, live regions; no screen-reader audit |
| Ext: waitlist, reminders, .ics, webhooks, round-robin, external busy times, live deployment | Not built | listed in report as next steps |
