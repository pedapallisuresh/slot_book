import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { createHmac, scryptSync, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { pool, expireHolds, createHold, confirmHold, cancelBooking, reschedule, getSlots, HttpError } from "./booking.js";

const SECRET = process.env.SECRET ?? "dev-secret-change-me";
const hash = (pw: string, salt = randomBytes(8).toString("hex")) => salt + ":" + scryptSync(pw, salt, 32).toString("hex");
const verify = (pw: string, h: string) => { const a = Buffer.from(hash(pw, h.split(":")[0])), b = Buffer.from(h); return a.length === b.length && timingSafeEqual(a, b); };
const mac = (b: string) => createHmac("sha256", SECRET).update(b).digest("hex");
const sign = (id: string) => { const b = `${id}.${Date.now() + 864e5}`; return `${b}.${mac(b)}`; };
const unsign = (t: string) => { const [id, exp, sig] = t.split("."); return id && sig && sig === mac(`${id}.${exp}`) && +exp > Date.now() ? id : null; };

const app = new Hono<{ Variables: { hostId: string } }>();
app.use("*", async (c, next) => { const t = Date.now(), rid = randomUUID().slice(0, 8); await next(); c.header("x-request-id", rid);
  console.log(JSON.stringify({ rid, m: c.req.method, p: c.req.path, s: c.res.status, ms: Date.now() - t })); });
const hits = new Map<string, number[]>();   // abuse protection: per-IP limit on public POSTs
app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.path.startsWith("/api/host")) {
    const ip = c.req.header("x-forwarded-for") ?? "local", now = Date.now();
    const a = (hits.get(ip) ?? []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a);
    if (a.length > Number(process.env.RATE_LIMIT ?? 120)) return c.json({ error: "rate limited" }, 429);
  }
  await next();
});
app.use("/api/host/*", async (c, next) => {
  const id = unsign((c.req.header("authorization") ?? "").replace("Bearer ", ""));
  if (!id) return c.json({ error: "unauthorized" }, 401);
  c.set("hostId", id); await next();
});
app.onError((e: any, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message }, e.status as any);
  if (e.code === "23514" || e.code === "22P02") return c.json({ error: "invalid value: " + (e.constraint ?? e.message) }, 400);
  if (e.code === "23505") return c.json({ error: "already exists" }, 409);
  console.error(e); return c.json({ error: "server error" }, 500);
});
const body = (c: any) => c.req.json().catch(() => ({}));

app.get("/health", async c => { await pool.query("select 1"); return c.json({ ok: true }); });

// ---- auth + host API
app.post("/api/auth/login", async c => {
  const { email, password } = await body(c);
  const h = (await pool.query("select id, password_hash from hosts where email=$1", [email])).rows[0];
  if (!h?.password_hash || !verify(String(password), h.password_hash)) throw new HttpError(401, "wrong email or password");
  return c.json({ token: sign(h.id) });
});
app.get("/api/host/me", async c => c.json((await pool.query("select id, slug, name, email, tz, daily_cap from hosts where id=$1", [c.get("hostId")])).rows[0]));
app.put("/api/host/me", async c => {
  const { tz, daily_cap } = await body(c);
  if (tz && !DateTime.local().setZone(tz).isValid) throw new HttpError(400, "invalid IANA time zone");
  await pool.query("update hosts set tz=coalesce($2,tz), daily_cap=$3 where id=$1", [c.get("hostId"), tz ?? null, daily_cap || null]); return c.json({ tz, daily_cap });
});
app.get("/api/host/event-types", async c => c.json((await pool.query("select * from event_types where host_id=$1 order by name", [c.get("hostId")])).rows));
app.post("/api/host/event-types", async c => {
  const b = await body(c);
  if (!/^[a-z0-9-]+$/.test(b.slug ?? "")) throw new HttpError(400, "slug: lowercase letters, digits, dashes");
  const r = await pool.query(
    `insert into event_types(host_id,slug,name,duration_min,capacity,buffer_before_min,buffer_after_min,min_notice_min,horizon_days)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [c.get("hostId"), b.slug, b.name, b.duration_min, b.capacity ?? 1, b.buffer_before_min ?? 0, b.buffer_after_min ?? 0, b.min_notice_min ?? 240, b.horizon_days ?? 30]);
  return c.json(r.rows[0], 201);
});
app.get("/api/host/availability", async c => c.json({
  rules: (await pool.query("select weekday, start_time::text, end_time::text from availability_rules where host_id=$1 order by weekday, start_time", [c.get("hostId")])).rows,
  overrides: (await pool.query("select on_date::text d, is_off, start_time::text, end_time::text from date_overrides where host_id=$1 order by on_date", [c.get("hostId")])).rows }));
app.put("/api/host/availability", async c => {
  const { rules = [], overrides = [] } = await body(c), id = c.get("hostId"), cl = await pool.connect();
  try {
    await cl.query("begin");
    await cl.query("delete from availability_rules where host_id=$1", [id]); await cl.query("delete from date_overrides where host_id=$1", [id]);
    for (const r of rules) await cl.query("insert into availability_rules(host_id,weekday,start_time,end_time) values($1,$2,$3,$4)", [id, r.weekday, r.start, r.end]);
    for (const o of overrides) await cl.query("insert into date_overrides(host_id,on_date,is_off,start_time,end_time) values($1,$2,$3,$4,$5)", [id, o.date, o.is_off, o.start ?? null, o.end ?? null]);
    await cl.query("commit");
  } catch (e) { await cl.query("rollback"); throw e; } finally { cl.release(); }
  return c.json({ ok: true });
});
app.get("/api/host/bookings", async c => c.json((await pool.query(
  `select b.id, b.start_at, b.guest_name, b.guest_email, e.name event_name from bookings b join event_types e on e.id=b.event_type_id
   where b.host_id=$1 and b.status='confirmed' and b.start_at > now() order by b.start_at`, [c.get("hostId")])).rows));
app.post("/api/host/bookings/:id/cancel", async c => {
  const { reason } = await body(c);
  const b = (await pool.query("select manage_token from bookings where id=$1 and host_id=$2", [c.req.param("id"), c.get("hostId")])).rows[0];
  if (!b) throw new HttpError(404, "booking not found");
  return c.json(await cancelBooking(b.manage_token, reason || "cancelled by host"));
});
app.get("/api/host/notifications", async c => c.json((await pool.query(
  `select n.kind, n.created_at, b.guest_email from notifications n join bookings b on b.id=n.booking_id where b.host_id=$1 order by n.id desc limit 20`, [c.get("hostId")])).rows));

// ---- public API
app.get("/api/hosts/:host", async c => {
  const h = (await pool.query("select id, name, tz from hosts where slug=$1", [c.req.param("host")])).rows[0];
  if (!h) throw new HttpError(404, "host not found");
  return c.json({ name: h.name, tz: h.tz, events: (await pool.query("select slug, name, duration_min, capacity from event_types where host_id=$1 order by duration_min", [h.id])).rows });
});
app.get("/api/hosts/:host/events/:slug", async c => {
  const r = (await pool.query(`select e.id, e.name, e.duration_min, e.capacity, h.name host_name, h.tz from event_types e join hosts h on h.id=e.host_id where h.slug=$1 and e.slug=$2`, [c.req.param("host"), c.req.param("slug")])).rows[0];
  if (!r) throw new HttpError(404, "event not found"); return c.json(r);
});
app.get("/api/hosts/:host/events/:slug/slots", async c =>
  c.json(await getSlots(c.req.param("host"), c.req.param("slug"), c.req.query("from"), c.req.query("to"), c.req.query("tz"))));
app.post("/api/holds", async c => {
  const key = c.req.header("idempotency-key"); if (!key) throw new HttpError(400, "Idempotency-Key header required");
  const { eventTypeId, start } = await body(c);
  if (!eventTypeId || isNaN(+new Date(start))) throw new HttpError(400, "eventTypeId and start required");
  return c.json(await createHold(eventTypeId, start, key), 201);
});
app.post("/api/holds/:id/confirm", async c => {
  const { name, email } = await body(c);
  if (!name || !/^\S+@\S+\.\S+$/.test(email ?? "")) throw new HttpError(400, "name and a valid email required");
  return c.json(await confirmHold(c.req.param("id"), name, email));
});
app.get("/api/bookings/:token", async c => {
  const r = (await pool.query(`select b.start_at, b.end_at, b.status, b.guest_name, e.name event_name, e.slug event_slug, h.slug host_slug, h.tz
    from bookings b join event_types e on e.id=b.event_type_id join hosts h on h.id=b.host_id where b.manage_token=$1`, [c.req.param("token")])).rows[0];
  if (!r) throw new HttpError(404, "booking not found"); return c.json(r);
});
app.post("/api/bookings/:token/reschedule", async c => c.json(await reschedule(c.req.param("token"), (await body(c)).start)));
app.post("/api/bookings/:token/cancel", async c => c.json(await cancelBooking(c.req.param("token"), (await body(c)).reason ?? "")));

// ---- pages
const page = (f: string) => async (c: any) => c.html(await readFile(new URL("../public/" + f, import.meta.url), "utf8"));
app.get("/", page("index.html"));
app.get("/host", page("host.html"));
app.get("/manage/:token", page("manage.html"));
app.get("/style.css", async c => c.body(await readFile(new URL("../public/style.css", import.meta.url), "utf8"), 200, { "content-type": "text/css" }));
app.get("/common.js", async c => c.body(await readFile(new URL("../public/common.js", import.meta.url), "utf8"), 200, { "content-type": "text/javascript" }));
app.get("/:host/:slug", page("book.html"));

let lagMax = 0, expiredTotal = 0;   // observability: hold expiries + notification dispatch lag
setInterval(async () => { try {
  expiredTotal += await expireHolds();
  const r = await pool.query("update notifications set delivered_at=now() where delivered_at is null returning extract(epoch from (now()-created_at))*1000 as lag");
  r.rows.forEach(x => { lagMax = Math.max(lagMax, +x.lag); });
} catch (e) { console.error(e); } }, 5000);
app.get("/metrics", async c => c.json({
  bookings_by_status: Object.fromEntries((await pool.query("select status, count(*)::int n from bookings group by status")).rows.map(r => [r.status, r.n])),
  hold_expiries_swept: expiredTotal, notification_lag_ms_max: Math.round(lagMax),
  notifications_pending: (await pool.query("select count(*)::int n from notifications where delivered_at is null")).rows[0].n }));

app.get("/:host", page("profile.html"));   // must stay AFTER fixed single-segment routes (/health, /metrics, /host, /style.css)

for (let i = 0; i < 30; i++) { try { await pool.query("select 1"); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
// Self-healing upgrade: older databases (Docker volumes) may lack newer columns; migrations only run on a fresh volume.
await pool.query(`alter table hosts add column if not exists password_hash text, add column if not exists daily_cap int check (daily_cap > 0);
  alter table notifications add column if not exists delivered_at timestamptz;`);
await pool.query("update hosts set password_hash=$1 where slug='demo' and password_hash is null", [hash("demo1234")]);   // seeded login
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, i => console.log(`Slotbook on http://localhost:${i.port}`));
