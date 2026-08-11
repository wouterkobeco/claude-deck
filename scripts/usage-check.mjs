// Checks the usage parse, and with --live prints the raw API response so the
// field names above can be confirmed against a real account.
// Run: node scripts/usage-check.mjs [--live]
import assert from "node:assert/strict";
import { parseUsage, fetchUsage, daysUntil, hoursUntil } from "../src/usage.mjs";

assert.deepEqual(
  parseUsage({
    five_hour: { utilization: 42, resets_at: "2026-08-11T15:00:00Z" },
    seven_day: { utilization: 88, resets_at: "2026-08-14T23:00:00Z" },
  }),
  { session: 42, week: 88, sessionResetsAt: "2026-08-11T15:00:00Z", weekResetsAt: "2026-08-14T23:00:00Z" }
);
assert.deepEqual(parseUsage({}), { session: null, week: null, sessionResetsAt: null, weekResetsAt: null });
console.log("OK: parseUsage");

const now = Date.parse("2026-08-11T12:00:00Z");
assert.equal(daysUntil(null, now), null);
assert.equal(daysUntil("2026-08-14T23:00:00Z", now), 4); // 3.46 days away, rounds up
assert.equal(daysUntil("2026-08-11T00:00:00Z", now), 0); // already past
console.log("OK: daysUntil");

assert.equal(hoursUntil(null, now), null);
assert.equal(hoursUntil("2026-08-11T15:00:00Z", now), 3);
assert.equal(hoursUntil("2026-08-11T15:20:00Z", now), 4); // 3.33h away, rounds up
assert.equal(hoursUntil("2026-08-11T00:00:00Z", now), 0); // already past
console.log("OK: hoursUntil");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await fetchUsage(), null, 2));
}
