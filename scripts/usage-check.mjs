// Checks the usage parse, and with --live prints the raw API response so the
// field names above can be confirmed against a real account.
// Run: node scripts/usage-check.mjs [--live]
import assert from "node:assert/strict";
import { parseUsage, fetchUsage, getUsage, daysUntil, hoursUntil } from "../src/usage.mjs";

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

// The daemon calls getUsage on every 2s poll while the response takes as long
// as it takes. `cache.at` is only written once a fetch resolves, so a request
// in flight has to be recognised as one — otherwise a slow endpoint gets a
// fresh request every poll, which is what earned a 429 in the first place.
// Uses a fake fetcher: this check must never touch the network.
let calls = 0;
const slowFetcher = async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 20));
  return { five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 2, resets_at: null } };
};
const results = await Promise.all([
  getUsage(Date.now(), slowFetcher),
  getUsage(Date.now(), slowFetcher),
  getUsage(Date.now(), slowFetcher),
]);
assert.equal(calls, 1, "three concurrent callers must share one request, not start three");
assert.deepEqual(results[0], results[2], "every concurrent caller gets the same value");
assert.equal(results[0].session, 1);

// ...and once it has resolved, the TTL keeps further callers off the network.
await getUsage(Date.now(), slowFetcher);
assert.equal(calls, 1, "a cached value must not trigger another request");
console.log("OK: getUsage request sharing");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await fetchUsage(), null, 2));
}
