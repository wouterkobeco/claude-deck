// Verifies the stats board's pure formatting/computation, and with --live
// prints the tiles computed from the real ~/.claude/stats-cache.json.
// Run: node scripts/stats-check.mjs [--live]
import assert from "node:assert/strict";
import { fmt, formatModel, computeStats, getStats } from "../src/stats.mjs";
import { refreshStats, cswapTiles } from "../src/index.mjs";

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
// computeStats itself still returns all 7 — the activity page shows every
// one of them. The deck drops "Active days" from its own copy (below); an
// eighth tile here would still push the rest of computeStats' own callers
// out of step, which is what this assertion is for.
assert.equal(stats.length, 7);
assert.deepEqual(stats[0], { label: "Favorite model", value: "Opus 4.8" });
assert.deepEqual(stats[4], { label: "Most active day", value: "Aug 8" });
assert.deepEqual(stats[6], { label: "Output tokens", value: "220" });

// The board itself, against a fake deck. This exists because refreshStats was
// once deleted outright by an edit to its neighbour and nothing caught it: the
// poll loop turns a throw into a "refresh failed:" line every 2s, so the board
// stops updating while the daemon goes on looking perfectly alive. Importing
// and calling it is the smallest thing that fails when that happens again.
{
  const written = [];
  const deck = { fillKeyBuffer: (index, buf) => written.push({ index, bytes: buf.length }) };
  const buttons = Array.from({ length: 13 }, (_, i) => ({ index: i, width: 72, height: 72, drawn: null }));
  // The list index.mjs actually builds: two reset tiles, "Total tokens", the
  // account name, the version, then two ring tiles per cswap account — the
  // other five stats left for the activity page to make that room — the back
  // key at 10, the config key at 11, blocked-today at 12.
  const deckStats = stats.filter((s) => s.label === "Total tokens");
  deckStats.push({ label: "Account", value: "Wouter" });
  const rings = cswapTiles([
    { name: "wouter", session: 12, week: 29.4 },
    { name: "claude2", session: null, week: 0 },
  ]);
  assert.deepEqual(rings[1], { label: "wouter 7d", value: "29", pie: 29.4 });
  assert.deepEqual(rings[2], { label: "claude2 5h", value: "—" }, "an unknown window is a dash, not an empty ring");
  deckStats.push(...rings);
  const tiles = [
    { label: "Session reset", value: "3h" },
    { label: "Week reset", value: "5d" },
    ...deckStats,
    { label: "Version", value: "9.9.9" },
  ];
  tiles[10] = { kind: "back" };
  tiles[11] = { kind: "config", glyph: "⚙", caps: "CONFIG" };
  tiles[12] = { label: "Blocked today", value: "41m" };
  assert.equal(tiles.length, 13, "the tile list fills every session slot exactly");

  await refreshStats(deck, buttons, tiles);
  // Two accounts fill 0..8, leaving key 9 blank — a blank is never encoded.
  const filled = tiles.filter(Boolean).length;
  assert.equal(filled, 12);
  assert.equal(written.length, filled, "every filled key is drawn on the first pass");
  assert.ok(written.every((w) => w.bytes === 72 * 72 * 4), "each one is a full RGBA key buffer");

  // The second pass is the diffing this board shares with every other: nothing
  // changed, so nothing is re-encoded.
  written.length = 0;
  await refreshStats(deck, buttons, tiles);
  assert.equal(written.length, 0, "an unchanged board redraws nothing");

  // A short list — an unreadable stats cache — blanks the rest rather than
  // leaving whatever was there, and the back key still lands on its own index.
  written.length = 0;
  const short = [];
  short[10] = { kind: "back" };
  await refreshStats(deck, buttons, short);
  // Eleven: the back key's signature is identical across the two lists and
  // key 9 was already blank, so the diff leaves those two alone. Everything
  // else blanks.
  assert.equal(written.length, filled - 1, "every key that changed is repainted");
  assert.deepEqual(buttons.map((b) => b.drawn).filter(Boolean), ['stat {"kind":"back"}'],
    "and only the way out is left drawn");
}

console.log("OK: computeStats, stats board");

if (process.argv.includes("--live")) {
  console.log(JSON.stringify(await getStats(), null, 2));
}
