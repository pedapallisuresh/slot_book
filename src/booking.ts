import { Pool, PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { windowsForDate, slotsFromWindows } from "./slots.js";
// Hosted Postgres (e.g. Supabase) needs SSL: set PGSSL=1 and do NOT put ?sslmode in the URL.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL ? { rejectUnauthorized: false } : undefined });
export class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }
// Expiry is evaluated at read time, so correctness never depends on a sweeper job.
const ACTIVE = `(status='confirmed' or (status='held' and hold_expires_at > now()))`;
const HOLD_MIN = 5;

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

/** Core invariant. Caller MUST hold the host row lock, which serialises all writers per host. */
async function assertFree(c: PoolClient, et: any, start: Date, excludeId: string | null) {
  const end = new Date(+start + et.duration_min * 60000);
  const bs = new Date(+start - et.buffer_before_min * 60000), be = new Date(+end + et.buffer_after_min * 60000);
  const same = await c.query(
    `select count(*)::int n from bookings where event_type_id=$1 and start_at=$2 and ${ACTIVE} and id is distinct from $3`,
    [et.id, start, excludeId]);
  if (same.rows[0].n >= et.capacity) throw new HttpError(409, "slot full");
  const clash = await c.query(
    `select 1 from bookings where host_id=$1 and ${ACTIVE} and id is distinct from $2
       and not (event_type_id=$3 and start_at=$4) and tstzrange(blocked_start,blocked_end) && tstzrange($5,$6) limit 1`,
    [et.host_id, excludeId, et.id, start, bs, be]);
  if (clash.rowCount) throw new HttpError(409, "overlaps another booking or buffer");
  return { end, bs, be };
}

/** Extension: host takes at most `daily_cap` bookings per host-local day. */
async function assertCap(c: PoolClient, host: any, start: Date, excludeId: string | null) {
  if (!host.daily_cap) return;
  const day = DateTime.fromJSDate(start, { zone: host.tz }).toISODate();
  const n = (await c.query(`select count(*)::int n from bookings where host_id=$1 and ${ACTIVE} and id is distinct from $4 and (start_at at time zone $2)::date = $3::date`, [host.id, host.tz, day, excludeId])).rows[0].n;
  if (n >= host.daily_cap) throw new HttpError(409, "host is fully booked that day");
}
/** Lifecycle: lapsed holds become 'expired' (correctness never depends on this; reads already ignore them). */
export const expireHolds = async () => (await pool.query("update bookings set status='expired' where status='held' and hold_expires_at <= now()")).rowCount ?? 0;

async function assertOffered(c: PoolClient, et: any, tz: string, start: Date) {
  const day = DateTime.fromJSDate(start, { zone: tz }).toISODate()!;
  const wd = DateTime.fromISO(day, { zone: tz }).weekday;
  const rules = (await c.query("select start_time::text, end_time::text from availability_rules where host_id=$1 and weekday=$2", [et.host_id, wd])).rows;
  const ov = (await c.query("select is_off, start_time::text, end_time::text from date_overrides where host_id=$1 and on_date=$2", [et.host_id, day])).rows[0];
  const ok = slotsFromWindows(windowsForDate(day, tz, rules, ov), et.duration_min, DateTime.now(), et.min_notice_min, et.horizon_days);
  if (!ok.some(s => +s === +start)) throw new HttpError(422, "slot not offered");
}
async function lockHostAndLoad(c: PoolClient, eventTypeId: string) {
  const et = (await c.query("select * from event_types where id=$1", [eventTypeId])).rows[0];
  if (!et) throw new HttpError(404, "event type not found");
  const host = (await c.query("select * from hosts where id=$1 for update", [et.host_id])).rows[0];
  return { et, host };
}

export const createHold = (eventTypeId: string, startISO: string, key: string) => tx(async c => {
  const { et, host } = await lockHostAndLoad(c, eventTypeId);   // lock first, then read the key => retries are race-free
  const prev = await c.query("select * from bookings where idempotency_key=$1", [key]);
  if (prev.rows[0]) return prev.rows[0];
  const start = new Date(startISO);
  await assertOffered(c, et, host.tz, start);
  await assertCap(c, host, start, null);
  const { end, bs, be } = await assertFree(c, et, start, null);
  return (await c.query(
    `insert into bookings(event_type_id,host_id,start_at,end_at,blocked_start,blocked_end,status,hold_expires_at,idempotency_key)
     values($1,$2,$3,$4,$5,$6,'held', now() + make_interval(mins => $7), $8) returning *`,
    [et.id, et.host_id, start, end, bs, be, HOLD_MIN, key])).rows[0];
});

export const confirmHold = (id: string, name: string, email: string) => tx(async c => {
  const pre = (await c.query("select host_id from bookings where id=$1", [id])).rows[0];
  if (!pre) throw new HttpError(404, "hold not found");
  await c.query("select 1 from hosts where id=$1 for update", [pre.host_id]);   // same lock order as createHold
  const b = (await c.query("select *, (hold_expires_at <= now()) as lapsed from bookings where id=$1 for update", [id])).rows[0];
  if (b.status === "confirmed") return b;                       // idempotent confirm
  if (b.status !== "held" || b.lapsed) {
    await c.query("update bookings set status='expired' where id=$1 and status='held'", [id]);
    throw new HttpError(410, "hold expired");
  }
  const dup = await c.query("select 1 from bookings where event_type_id=$1 and lower(guest_email)=lower($2) and status='confirmed' and start_at > now() and id<>$3 limit 1", [b.event_type_id, email, id]);
  if (dup.rowCount) throw new HttpError(409, "you already have an active booking for this event");   // per-guest limit
  const r = (await c.query(
    "update bookings set status='confirmed', guest_name=$2, guest_email=$3, manage_token=$4, hold_expires_at=null where id=$1 returning *",
    [id, name, email, randomBytes(24).toString("base64url")])).rows[0];
  await c.query("insert into notifications(booking_id,kind,payload) values($1,'confirmed',$2)", [id, r]);
  return r;
});

export const cancelBooking = (token: string, reason: string) => tx(async c => {
  const b = (await c.query("select * from bookings where manage_token=$1 for update", [token])).rows[0];
  if (!b) throw new HttpError(404, "not found");
  if (b.status === "cancelled") return b;                       // idempotent
  const r = (await c.query("update bookings set status='cancelled', cancel_reason=$2 where id=$1 returning *", [b.id, reason])).rows[0];
  await c.query("insert into notifications(booking_id,kind,payload) values($1,'cancelled',$2)", [b.id, r]);
  return r;
});

export const reschedule = (token: string, newStartISO: string) => tx(async c => {
  const b0 = (await c.query("select * from bookings where manage_token=$1", [token])).rows[0];
  if (!b0) throw new HttpError(404, "not found");
  const { et, host } = await lockHostAndLoad(c, b0.event_type_id);
  const b = (await c.query("select * from bookings where id=$1 for update", [b0.id])).rows[0];
  if (b.status !== "confirmed") throw new HttpError(409, "only confirmed bookings can move");
  const start = new Date(newStartISO);
  await assertOffered(c, et, host.tz, start);
  await assertCap(c, host, start, b.id);
  const { end, bs, be } = await assertFree(c, et, start, b.id); // excludes itself; failure rolls back, old slot untouched
  const r = (await c.query("update bookings set start_at=$2,end_at=$3,blocked_start=$4,blocked_end=$5 where id=$1 returning *", [b.id, start, end, bs, be])).rows[0];
  await c.query("insert into notifications(booking_id,kind,payload) values($1,'rescheduled',$2)", [b.id, r]);
  return r;
});

/** Public slot list: host-local days -> UTC instants, minus full slots and buffered overlaps. */
export async function getSlots(hostSlug: string, evSlug: string, fromISO?: string, toISO?: string, tz?: string) {
  const et = (await pool.query(`select e.*, h.tz, h.name host_name, h.daily_cap from event_types e join hosts h on h.id=e.host_id where h.slug=$1 and e.slug=$2`, [hostSlug, evSlug])).rows[0];
  if (!et) throw new HttpError(404, "event not found");
  const now = DateTime.now();
  const from = fromISO ? DateTime.fromISO(fromISO, { zone: et.tz }) : now.setZone(et.tz);
  const to = toISO ? DateTime.fromISO(toISO, { zone: et.tz }) : from.plus({ days: et.horizon_days });
  const rules = (await pool.query("select weekday, start_time::text, end_time::text from availability_rules where host_id=$1", [et.host_id])).rows;
  const ovs = (await pool.query("select on_date::text d, is_off, start_time::text, end_time::text from date_overrides where host_id=$1", [et.host_id])).rows;
  const busy = (await pool.query(`select event_type_id, start_at, blocked_start, blocked_end from bookings where host_id=$1 and ${ACTIVE} and blocked_end > now()`, [et.host_id])).rows;
  const perDay: Record<string, number> = {};
  busy.forEach(b => { const k = DateTime.fromJSDate(b.start_at, { zone: et.tz }).toISODate()!; perDay[k] = (perDay[k] ?? 0) + 1; });
  const slots: { start: string; local: string; remaining: number }[] = [];
  for (let d = from.startOf("day"); d <= to; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    if (et.daily_cap && (perDay[date] ?? 0) >= et.daily_cap) continue;
    const ws = windowsForDate(date, et.tz, rules.filter(r => r.weekday === d.weekday), ovs.find(o => o.d === date));
    for (const s of slotsFromWindows(ws, et.duration_min, now, et.min_notice_min, et.horizon_days)) {
      if (s < from.toJSDate() || s > to.toJSDate()) continue;
      const e = new Date(+s + et.duration_min * 60000), bs = new Date(+s - et.buffer_before_min * 60000), be = new Date(+e + et.buffer_after_min * 60000);
      const sameSlot = (b: any) => b.event_type_id === et.id && +b.start_at === +s;
      const same = busy.filter(sameSlot).length;
      const clash = busy.some(b => !sameSlot(b) && b.blocked_start < be && b.blocked_end > bs);
      if (!clash && same < et.capacity)
        slots.push({ start: s.toISOString(), local: DateTime.fromJSDate(s, { zone: tz || et.tz }).toISO()!, remaining: et.capacity - same });
    }
  }
  return { eventTypeId: et.id, host_tz: et.tz, duration_min: et.duration_min, slots };
}
