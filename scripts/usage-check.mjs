// Checks the usage parse, and with --live prints the raw API response so the
// field names above can be confirmed against a real account.
// Run: node scripts/usage-check.mjs [--live]
import assert from "node:assert/strict";
import { parseUsage, fetchUsage, getUsage, daysUntil, hoursUntil, formatReset, subscriptionChange, TTL_MS, _resetIdentityWatchForTests } from "../src/usage.mjs";

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

assert.equal(formatReset(null, "hours", now), null);
assert.equal(formatReset("2026-08-11T15:00:00Z", "hours", now), "3h"); // >= 1h left, coarse unit
assert.equal(formatReset("2026-08-11T12:45:00Z", "hours", now), "45m"); // < 1h left, drops to minutes
assert.equal(formatReset("2026-08-14T23:00:00Z", "days", now), "4d");
assert.equal(formatReset("2026-08-12T09:00:00Z", "days", now), "21h"); // < 24h left, drops to hours rather than reading "1d"
assert.equal(formatReset("2026-08-11T12:30:00Z", "days", now), "30m"); // same drop applies to the week tile
console.log("OK: formatReset");

assert.deepEqual(subscriptionChange(undefined, "max", "default_claude_max_20x"), {
  key: "max/default_claude_max_20x",
  message: null, // first read is discovery, not a switch
});
assert.deepEqual(subscriptionChange("max/default_claude_max_20x", "max", "default_claude_max_20x"), {
  key: "max/default_claude_max_20x",
  message: null,
});
assert.deepEqual(subscriptionChange("max/default_claude_max_20x", "pro", "default_claude_pro"), {
  key: "pro/default_claude_pro",
  message: "usage: subscription changed (max/default_claude_max_20x -> pro/default_claude_pro)",
});
console.log("OK: subscriptionChange");

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

// 429 backoff. The endpoint 429s bursts it never warned about — no
// ratelimit headers, and a `retry-after: 0` that would have us retry
// immediately — so each consecutive 429 waits a TTL longer than the last, and
// one success drops straight back to the plain TTL. Times are driven by the
// `now` argument; nothing here sleeps or touches the network.
let denials = 0;
const rateLimited = async () => {
  denials++;
  throw new Error("usage endpoint returned 429");
};

// A TTL after the last good fetch above, so this one goes out — and is denied.
await getUsage(Date.now() + TTL_MS, rateLimited);
assert.equal(denials, 1);
assert.equal(calls, 1, "a denied request must not blank the cached value");

// One TTL on, the plain cache would have expired; the backoff must hold it.
await getUsage(Date.now() + TTL_MS, rateLimited);
assert.equal(denials, 1, "the first 429 must buy a TTL of quiet on top of the cache");

// Two TTLs on it asks again, is denied again, and doubles to a 2-TTL wait.
await getUsage(Date.now() + 2 * TTL_MS, rateLimited);
assert.equal(denials, 2);
await getUsage(Date.now() + 2 * TTL_MS + 30_000, rateLimited);
assert.equal(denials, 2, "a second 429 must wait longer than the first");

// Whatever the key was showing before the 429s, it is still showing — a
// rate-limited lookup is not a reason to blank a number that is minutes old.
const held = await getUsage(Date.now(), rateLimited);
assert.equal(held.session, 1, "the last good value survives a run of 429s");

// A success clears the backoff: the next request is due one plain TTL later,
// not three.
await getUsage(Date.now() + 3 * TTL_MS, slowFetcher);
assert.equal(calls, 2);
await getUsage(Date.now() + TTL_MS, slowFetcher);
assert.equal(calls, 3, "one success must drop the backoff back to the plain TTL");
console.log("OK: getUsage 429 backoff");

// A `cswap switch` (or any keychain rewrite) changes the token instantly, but
// the cached numbers have no way to know until something asks the keychain
// again — the whole reason getUsage() also watches identity, on a much
// shorter cadence than the usage TTL itself, and forces an early refetch the
// moment the fingerprint changes.
//
// `cache.at` is always stamped with the real clock (not the injected `now`),
// even in these checks, so every timestamp below is built off a single real
// `Date.now()` read (`T0`) and stays within a few seconds of it — comfortably
// inside the 5-minute TTL throughout. That's what lets the final assertion
// mean what it says: the forced refetch has to be the identity watch, because
// the TTL alone never comes close to expiring in this window.
_resetIdentityWatchForTests();
const flush = () => new Promise((r) => setImmediate(r));
const IDENTITY_CHECK_MS = 10_000;
const T0 = Date.now();
const credA = async () => ({ accessToken: "acct-A-token", subscriptionType: "max", rateLimitTier: "t" });
const credB = async () => ({ accessToken: "acct-B-token", subscriptionType: "max", rateLimitTier: "t" });
let fetchesA = 0;
const fetcherA = async () => {
  fetchesA++;
  return { five_hour: { utilization: 11 } };
};
let fetchesB = 0;
const fetcherB = async () => {
  fetchesB++;
  return { five_hour: { utilization: 22 } };
};

// The very first identity read is discovery, not a change — nothing to
// compare against yet — so it only establishes account A as the baseline.
await getUsage(T0, fetcherA, credA);
await flush();
await flush();
assert.equal(fetchesA, 0, "a first-ever identity read must not itself force a fetch");

// Moments later, same account, well under the identity check's own interval:
// no new probe fires, and the cache (untouched) needs no refetch either.
await getUsage(T0 + 2000, fetcherA, credA);
assert.equal(fetchesA, 0, "an unchanged identity, still within its own check interval, does nothing");

// The switch: a new account's token, and enough time for the identity watch
// to actually fire again — but the fetch it kicks off is fire-and-forget, so
// this read still can't have seen the result yet.
await getUsage(T0 + IDENTITY_CHECK_MS + 2000, fetcherA, credB);
assert.equal(fetchesA, 0, "the read that triggers the identity check can't be the one it affects");
await flush();
await flush();

// Now that it has resolved: the very next read forces a real fetch, seconds
// after the last one and nowhere near the 5-minute TTL — and it's account
// B's numbers, not a repeat of A's.
const afterSwitch = await getUsage(T0 + IDENTITY_CHECK_MS + 3000, fetcherB, credB);
assert.equal(fetchesB, 1, "forced by the fingerprint change, not by the TTL — which hasn't come close to expiring");
assert.equal(afterSwitch.session, 22, "and the value is account B's, not a stale copy of A's");
console.log("OK: getUsage forces a refresh when the keychain credential changes");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await fetchUsage(), null, 2));
}
