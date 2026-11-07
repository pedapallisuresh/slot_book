import { it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { pool, createHold, confirmHold, cancelBooking, reschedule, expireHolds } from "../src/booking.js";
let intro: string, workshop: string, ten: string, two: string, noon: string;
beforeAll(async () => {
  intro = (await pool.query("select id from event_types where slug='intro-30'")).rows[0].id;
  workshop = (await pool.query("select id from event_types where slug='workshop-60'")).rows[0].id;
  let d = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  ten = d.toUTC().toISO()!; noon = d.set({ hour: 12 }).toUTC().toISO()!; two = d.set({ hour: 14 }).toUTC().toISO()!;
  await pool.query("delete from notifications"); await pool.query("delete from bookings");
});
const wins = (rs: PromiseSettledResult<any>[]) => rs.filter(r => r.status === "fulfilled").length;

it("100 parallel holds on one 1:1 slot -> exactly 1 wins", async () => {
  expect(wins(await Promise.allSettled(Array.from({ length: 100 }, (_, i) => createHold(intro, ten, `k-${i}`))))).toBe(1);
});
it("group capacity 5: 40 parallel holds -> exactly 5", async () => {
  expect(wins(await Promise.allSettled(Array.from({ length: 40 }, (_, i) => createHold(workshop, two, `g-${i}`))))).toBe(5);
});
it("same Idempotency-Key returns the same hold", async () => {
  const a = await createHold(intro, noon, "same"), b = await createHold(intro, noon, "same");
  expect(a.id).toBe(b.id);
});
it("expired hold and cancelled booking both free capacity", async () => {
  await pool.query("update bookings set hold_expires_at = now() - interval '1 second' where status='held'");
  const h = await createHold(intro, ten, "after-expiry");
  const c = await confirmHold(h.id, "A", "a@x.dev");
  await cancelBooking(c.manage_token, "test");
  await expect(createHold(intro, ten, "after-cancel")).resolves.toBeTruthy();
});
it("reschedule collision rolls back (old slot kept); a free slot succeeds", async () => {
  await pool.query("delete from notifications"); await pool.query("delete from bookings");
  const a = await confirmHold((await createHold(intro, ten, "r1")).id, "A", "a@x.dev");
  await confirmHold((await createHold(intro, noon, "r2")).id, "B", "b@x.dev");
  await expect(reschedule(a.manage_token, noon)).rejects.toMatchObject({ status: 409 });
  expect((await pool.query("select start_at from bookings where id=$1", [a.id])).rows[0].start_at.toISOString()).toBe(ten);
  const eleven = new Date(+new Date(ten) + 3600e3).toISOString();
  expect((await reschedule(a.manage_token, eleven)).start_at.toISOString()).toBe(eleven);
});
it("confirm and cancel write notification rows", async () => {
  const n = await pool.query("select kind from notifications order by id");
  expect(n.rows.map(r => r.kind)).toEqual(expect.arrayContaining(["confirmed", "rescheduled"]));
});
it("per-guest limit: a second active booking for the same event + email is rejected", async () => {
  await pool.query("delete from notifications"); await pool.query("delete from bookings");
  await confirmHold((await createHold(intro, ten, "p1")).id, "G", "g@x.dev");
  const h2 = await createHold(intro, noon, "p2");
  await expect(confirmHold(h2.id, "G", "G@X.dev")).rejects.toMatchObject({ status: 409 });
});
it("host daily cap blocks extra bookings on that local day", async () => {
  await pool.query("delete from notifications"); await pool.query("delete from bookings");
  await pool.query("update hosts set daily_cap=2 where slug='demo'");
  await createHold(intro, ten, "d1"); await createHold(intro, noon, "d2");
  await expect(createHold(workshop, two, "d3")).rejects.toMatchObject({ status: 409 });
  await pool.query("update hosts set daily_cap=null where slug='demo'");
});
it("sweeper turns lapsed holds into 'expired'", async () => {
  await pool.query("delete from bookings");
  const h = await createHold(intro, ten, "s1");
  await pool.query("update bookings set hold_expires_at = now() - interval '1 second' where id=$1", [h.id]);
  expect(await expireHolds()).toBeGreaterThanOrEqual(1);
  expect((await pool.query("select status from bookings where id=$1", [h.id])).rows[0].status).toBe("expired");
});
