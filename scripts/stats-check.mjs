// Verifies the stats board's pure formatting/computation, and with --live
// prints the tiles computed from the real ~/.claude/stats-cache.json.
// Run: node scripts/stats-check.mjs [--live]
import assert from "node:assert/strict";
import { fmt, formatModel, computeStats, getStats } from "../src/stats.mjs";

assert.equal(fmt(950), "950");
assert.equal(fmt(4371), "4.4k");
assert.equal(fmt(66_287_987_000), "66.3b");
assert.equal(fmt(66_287_987_000, 0), "66b"); // token tiles drop the decimal
assert.equal(fmt(950, 0), "950");
console.log("OK: fmt");

assert.equal(formatModel("claude-opus-4-8"), "Opus 4.8");
assert.equal(formatModel("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
assert.equal(formatModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
console.log("OK: formatModel");

assert.deepEqual(computeStats(null), []);
const stats = computeStats({
  modelUsage: {
    "claude-opus-4-8": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50 },
    "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 },
  },
  dailyActivity: [
    { date: "2026-08-07", messageCount: 10 },
    { date: "2026-08-08", messageCount: 50 },
  ],
  totalSessions: 12,
  firstSessionDate: "2026-08-01T00:00:00.000Z",
  lastComputedDate: "2026-08-08",
});
// 7 stats + the 2 reset tiles index.mjs prepends + the version tile it
// appends = 10, filling indices 0-9 and leaving index 10 (the bottom-left
// button) for the back key, 11 for the config key and 12 for blocked-today.
// An eighth stat would push each of those one along and the last off the
// board entirely — silently, which is what this assertion is for.
// (13 session slots since the free key folded into the status key; the board
// fills all of them exactly.)
assert.equal(stats.length, 7);
assert.deepEqual(stats[0], { label: "Favorite model", value: "Opus 4.8" });
assert.deepEqual(stats[4], { label: "Most active day", value: "Aug 8" });
assert.deepEqual(stats[6], { label: "Output tokens", value: "220" });
console.log("OK: computeStats");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await getStats(), null, 2));
}
