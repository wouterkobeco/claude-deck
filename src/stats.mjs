import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATS_PATH = join(homedir(), ".claude", "stats-cache.json");
const TTL_MS = 30_000;

/**
 * "68613583898" -> "68.6b". Matches the compact style Claude Code itself uses.
 * `digits: 0` drops the decimal — the token counts read as magnitudes, and one
 * decimal is a false precision that just eats width at the larger value font.
 * Session counts keep it: "1.3k" and "1k" are a real difference there.
 */
export function fmt(n, digits = 1) {
  if (n >= 1e9) return (n / 1e9).toFixed(digits) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(digits) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(digits) + "k";
  return String(Math.round(n));
}

/** "claude-opus-4-8" -> "Opus 4.8"; drops a trailing date-stamp id like "-20250929". */
export function formatModel(id) {
  const parts = id.replace(/^claude-/, "").split("-");
  const nameParts = [];
  for (const p of parts) {
    if (/^\d{6,}$/.test(p)) break;
    nameParts.push(p);
  }
  const [name, ...version] = nameParts;
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return version.length ? `${label} ${version.join(".")}` : label;
}

/** Ordered tiles for the stats board, or [] if the cache can't be read. */
export function computeStats(raw) {
  if (!raw) return [];

  const { modelUsage = {}, dailyActivity = [], totalSessions, firstSessionDate, lastComputedDate } = raw;

  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let topModel = null,
    topWeight = -1;
  for (const [id, u] of Object.entries(modelUsage)) {
    const input = u.inputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    const cacheRead = u.cacheReadInputTokens ?? 0;
    const cacheWrite = u.cacheCreationInputTokens ?? 0;
    totals = {
      input: totals.input + input,
      output: totals.output + output,
      cacheRead: totals.cacheRead + cacheRead,
      cacheWrite: totals.cacheWrite + cacheWrite,
    };
    const weight = input + output + cacheRead + cacheWrite;
    if (weight > topWeight) {
      topWeight = weight;
      topModel = id;
    }
  }
  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

  const activeDates = dailyActivity.map((d) => d.date);
  const mostActive = dailyActivity.reduce((a, b) => (b.messageCount > (a?.messageCount ?? -1) ? b : a), null);
  const spanDays =
    firstSessionDate && lastComputedDate
      ? Math.floor((Date.parse(lastComputedDate) - Date.parse(firstSessionDate.slice(0, 10))) / 86_400_000) + 1
      : activeDates.length;

  return [
    { label: "Favorite model", value: topModel ? formatModel(topModel) : "—" },
    { label: "Total tokens", value: fmt(totalTokens, 0) },
    { label: "Sessions", value: fmt(totalSessions ?? 0) },
    { label: "Active days", value: `${activeDates.length}/${spanDays}` },
    {
      label: "Most active day",
      value: mostActive
        ? new Date(`${mostActive.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "—",
    },
    { label: "Input tokens", value: fmt(totals.input, 0) },
    { label: "Output tokens", value: fmt(totals.output, 0) },
    // Seven tiles: index.mjs brackets this list with the reset pair before it
    // and the version after, then puts the back key on the bottom-left button
    // (index 10). An eighth tile here would land under that key and never be
    // seen.
  ];
}

let cache = { at: 0, value: [] };
let lastError = null;

/** Cached stats tiles, safe to call on every poll. Stale cache on failure, same as usage.mjs. */
export async function getStats(now = Date.now()) {
  if (now - cache.at < TTL_MS) return cache.value;
  try {
    const raw = JSON.parse(await readFile(STATS_PATH, "utf8"));
    cache = { at: now, value: computeStats(raw) };
    lastError = null;
  } catch (err) {
    cache = { ...cache, at: now - TTL_MS / 2 };
    if (err.message !== lastError) {
      console.error("stats lookup failed:", err.message);
      lastError = err.message;
    }
  }
  return cache.value;
}
