import { it, expect } from "vitest";
import { DateTime } from "luxon";
import { windowsForDate, slotsFromWindows } from "../src/slots.js";
const rule = [{ start_time: "09:00:00", end_time: "10:00:00" }];
const now = DateTime.fromISO("2026-03-01T00:00:00Z");
const first = (d: string, ov?: any) => slotsFromWindows(windowsForDate(d, "America/New_York", rule, ov), 60, now, 0, 30)[0]?.toISOString();
it("New York 09:00 is 14:00Z before DST and 13:00Z after (DST began 2026-03-08)", () => {
  expect(first("2026-03-06")).toBe("2026-03-06T14:00:00.000Z");
  expect(first("2026-03-09")).toBe("2026-03-09T13:00:00.000Z");
});
it("day-off override removes slots; custom hours replace weekly rules", () => {
  expect(first("2026-03-10", { is_off: true })).toBeUndefined();
  expect(first("2026-03-10", { is_off: false, start_time: "11:00:00", end_time: "12:00:00" })).toBe("2026-03-10T15:00:00.000Z");
});
it("min notice and horizon are enforced", () => {
  expect(slotsFromWindows(windowsForDate("2026-03-02", "UTC", rule), 60, DateTime.fromISO("2026-03-02T08:00:00Z"), 120, 30)).toHaveLength(0);
  expect(slotsFromWindows(windowsForDate("2026-06-02", "UTC", rule), 60, now, 0, 30)).toHaveLength(0);
});
