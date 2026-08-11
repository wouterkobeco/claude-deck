// Verifies the stats board's pure formatting/computation, and with --live
// prints the tiles computed from the real ~/.claude/stats-cache.json.
// Run: node scripts/stats-check.mjs [--live]
import assert from "node:assert/strict";
import { fmt, formatDuration, formatModel, computeStreaks, computeStats, getStats } from "../src/stats.mjs";

assert.equal(fmt(950), "950");
assert.equal(fmt(4371), "4.4k");
assert.equal(fmt(66_287_987_000), "66.3b");
console.log("OK: fmt");

// 763621380ms is a real longestSession.duration from this machine's cache —
// pinned here because it's the value that first caught a rounding bug.
assert.equal(formatDuration(763621380), "8d 20h 7m");
console.log("OK: formatDuration");

assert.equal(formatModel("claude-opus-4-8"), "Opus 4.8");
assert.equal(formatModel("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
assert.equal(formatModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
console.log("OK: formatModel");

// Dec 23-26 (streak of 4), then a gap, then Dec 30-31 (streak of 2, current).
assert.deepEqual(
  computeStreaks(["2025-12-23", "2025-12-24", "2025-12-25", "2025-12-26", "2025-12-30", "2025-12-31"]),
  { longest: 4, current: 2 }
);
console.log("OK: computeStreaks");

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
  longestSession: { duration: 3_723_000 }, // 1h 2m 3s -> rounds to 1h 2m
  firstSessionDate: "2026-08-01T00:00:00.000Z",
  lastComputedDate: "2026-08-08",
});
assert.equal(stats.length, 12);
assert.deepEqual(stats[0], { label: "Favorite model", value: "Opus 4.8" });
assert.deepEqual(stats[4], { label: "Most active day", value: "Aug 8" });
console.log("OK: computeStats");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await getStats(), null, 2));
}
