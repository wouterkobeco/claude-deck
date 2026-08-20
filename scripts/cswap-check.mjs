import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCswap, getCswapAccounts, withLiveUsage } from "../src/cswap.mjs";

const sequence = { activeAccountNumber: 3, accounts: { 3: { email: "b@x.com" }, 2: { email: "a@x.com" } } };
const usage = {
  accounts: {
    2: { lastGood: { five_hour: { pct: 0 }, seven_day: { pct: 29, resets_at: "2026-08-26T06:00:00+00:00" } } },
  },
};
const parsed = parseCswap(sequence, usage);
assert.deepEqual(parsed.map((a) => a.slot), ["3", "2"], "active first, then slot order");
assert.deepEqual(parsed[1], {
  slot: "2", email: "a@x.com", name: "a", active: false,
  session: 0, week: 29, sessionResetsAt: null, weekResetsAt: "2026-08-26T06:00:00+00:00",
});
assert.deepEqual([parsed[0].active, parsed[0].session, parsed[0].week], [true, null, null], "no usage yet is unknown, not zero");

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
console.log("cswap-check ok");
