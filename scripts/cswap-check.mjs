import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCswap, getCswapAccounts, withLiveUsage, needsRefresh, maybeRefreshCswap } from "../src/cswap.mjs";

const sequence = { activeAccountNumber: 3, accounts: { 3: { email: "b@x.com" }, 2: { email: "a@x.com" } } };
const usage = {
  accounts: {
    2: { lastGood: { five_hour: { pct: 0 }, seven_day: { pct: 29, resets_at: "2026-08-26T06:00:00+00:00" } } },
  },
};
const before = Date.parse("2026-08-22T00:00:00Z");
const parsed = parseCswap(sequence, usage, before);
assert.deepEqual(parsed.map((a) => a.slot), ["3", "2"], "active first, then slot order");
assert.deepEqual(parsed[1], {
  slot: "2", email: "a@x.com", name: "a", active: false,
  session: 0, week: 29, sessionResetsAt: null, weekResetsAt: "2026-08-26T06:00:00+00:00",
});
assert.deepEqual([parsed[0].active, parsed[0].session, parsed[0].week], [true, null, null], "no usage yet is unknown, not zero");

// A cached window whose reset time has passed already ended — cswap hasn't
// refreshed since, so the percentage is for a window that no longer exists.
// Unknown beats wrong; a window with no resets_at at all can't be judged.
const expired = parseCswap(sequence, usage, Date.parse("2026-09-01T00:00:00Z"));
assert.deepEqual([expired[1].week, expired[1].weekResetsAt], [null, null], "an expired window reads unknown, not stale");
assert.equal(expired[1].session, 0, "a window without resets_at keeps its number");

// Files: absent root is [], sequence alone still lists accounts.
assert.deepEqual(await getCswapAccounts(1, join(tmpdir(), "no-such-cswap")), []);
const root = await mkdtemp(join(tmpdir(), "cswap-"));
await writeFile(join(root, "sequence.json"), JSON.stringify(sequence));
assert.equal((await getCswapAccounts(100_000, root)).length, 2, "no usage cache still names the accounts");
await mkdir(join(root, "cache"));
await writeFile(join(root, "cache", "usage.json"), "{not json");
assert.equal((await getCswapAccounts(200_000, root)).length, 2, "a half-written usage cache is tolerated");

// The active account takes the daemon's own live numbers over cswap's cache
// (which can be stale or missing a reset); the others keep what cswap has.
const merged = withLiveUsage(parsed, { session: 9, week: 61, sessionResetsAt: "2026-08-20T20:30:00Z", weekResetsAt: null });
assert.deepEqual([merged[0].session, merged[0].sessionResetsAt, merged[0].week], [9, "2026-08-20T20:30:00Z", 61]);
assert.equal(merged[1].week, 29, "inactive accounts are untouched");

// The daemon keeps cswap's cache fresh rather than repeating a stale one:
// refresh when the newest fetch is over an hour old or a cached window has
// already reset. fetchedAt is in seconds, cswap's own unit.
const HOUR = 3_600_000;
const t0 = Date.parse("2026-09-01T00:00:00Z");
const fresh = {
  accounts: {
    2: { fetchedAt: t0 / 1000, lastGood: { seven_day: { pct: 10, resets_at: "2026-09-02T06:00:00Z" } } },
  },
};
assert.equal(needsRefresh(fresh, t0 + HOUR / 2), false, "a fresh cache with live windows stays put");
assert.equal(needsRefresh(fresh, t0 + 2 * HOUR), true, "an hour-old cache refreshes");
assert.equal(needsRefresh(fresh, Date.parse("2026-09-02T07:00:00Z")), true, "an expired window refreshes even a 'recent' cache");
assert.equal(needsRefresh(null, t0), false, "no cache at all means cswap isn't here — nothing to run");
assert.equal(needsRefresh({ accounts: {} }, t0), false);

// One run at a time, and a cooldown between attempts — the endpoint behind
// cswap 429s freely, so a failing run must not be hammered.
let runs = 0;
let finish;
const fakeRun = (done) => { runs++; finish = done; };
const stale = { accounts: { 2: { fetchedAt: 0, lastGood: {} } } };
assert.equal(maybeRefreshCswap(stale, t0, fakeRun), true, "a stale cache fires a refresh");
assert.equal(maybeRefreshCswap(stale, t0 + 1000, fakeRun), false, "not while one is in flight");
finish();
assert.equal(maybeRefreshCswap(stale, t0 + 60_000, fakeRun), false, "cooldown holds after it lands");
assert.equal(maybeRefreshCswap(stale, t0 + 11 * 60_000, fakeRun), true, "and lifts");
finish();
assert.equal(runs, 2);
assert.equal(maybeRefreshCswap(fresh, t0 + 22 * 60_000, fakeRun), false, "a fresh cache never fires");

console.log("cswap-check ok");
