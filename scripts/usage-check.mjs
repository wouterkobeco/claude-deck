// Checks the usage parse, and with --live prints the raw API response so the
// field names above can be confirmed against a real account.
// Run: node scripts/usage-check.mjs [--live]
import assert from "node:assert/strict";
import { parseUsage, fetchUsage } from "../src/usage.mjs";

assert.deepEqual(parseUsage({ five_hour: { utilization: 42 }, seven_day: { utilization: 88 } }), {
  session: 42,
  week: 88,
});
assert.deepEqual(parseUsage({}), { session: null, week: null });
console.log("OK: parseUsage");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await fetchUsage(), null, 2));
}
