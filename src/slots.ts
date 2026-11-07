import { DateTime } from "luxon";
export type Win = { start: DateTime; end: DateTime };
/** Windows for one host-local date, built from LOCAL wall-clock times so DST is handled by luxon. */
export function windowsForDate(date: string, tz: string, rules: {start_time:string;end_time:string}[],
  override?: {is_off:boolean;start_time?:string;end_time?:string}): Win[] {
  const mk = (t: string) => DateTime.fromISO(`${date}T${t.slice(0,5)}`, { zone: tz });
  if (override?.is_off) return [];
  const src = override?.start_time ? [{start_time: override.start_time, end_time: override.end_time!}] : rules;
  return src.map(r => ({ start: mk(r.start_time), end: mk(r.end_time) })).filter(w => w.start.isValid && w.end > w.start);
}
/** Slots tile each window every `durMin`; drop those inside min-notice or past the horizon. */
export function slotsFromWindows(ws: Win[], durMin: number, now: DateTime, minNoticeMin: number, horizonDays: number): Date[] {
  const out: Date[] = [], earliest = now.plus({ minutes: minNoticeMin }), latest = now.plus({ days: horizonDays });
  for (const w of ws) for (let s = w.start; s.plus({ minutes: durMin }) <= w.end; s = s.plus({ minutes: durMin }))
    if (s >= earliest && s <= latest) out.push(s.toJSDate());
  return out;
}
