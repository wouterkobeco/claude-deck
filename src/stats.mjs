import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATS_PATH = join(homedir(), ".claude", "stats-cache.json");
const TTL_MS = 30_000;

/** "68613583898" -> "68.6b". Matches the compact style Claude Code itself uses. */
export function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Milliseconds -> "8d 20h 7m". */
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return `${d}d ${h}h ${m}m`;
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

/**
 * Longest and current run of consecutive active days, from the dates already
 * present in dailyActivity — Claude Code only writes an entry for a day that
 * had a session, so gaps in the array are gaps in activity. "Current" is the
 * run ending on the most recent recorded day, not necessarily today: the
 * cache lags by up to a day, and treating that lag as a broken streak would
 * be wrong more often than it's right.
 */
export function computeStreaks(dates) {
  const sorted = [...new Set(dates)].sort();
  let longest = 0,
    run = 0,
    prevDay = null;
  for (const d of sorted) {
    const day = Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    run = prevDay !== null && day - prevDay === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prevDay = day;
  }
  return { longest, current: run };
}

/** Ordered tiles for the stats board, or [] if the cache can't be read. */
export function computeStats(raw) {
  if (!raw) return [];

  const { modelUsage = {}, dailyActivity = [], totalSessions, longestSession, firstSessionDate, lastComputedDate } = raw;

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
  const { longest: longestStreak, current: currentStreak } = computeStreaks(activeDates);
  const mostActive = dailyActivity.reduce((a, b) => (b.messageCount > (a?.messageCount ?? -1) ? b : a), null);
  const spanDays =
    firstSessionDate && lastComputedDate
      ? Math.floor((Date.parse(lastComputedDate) - Date.parse(firstSessionDate.slice(0, 10))) / 86_400_000) + 1
      : activeDates.length;

  return [
    { label: "Favorite model", value: topModel ? formatModel(topModel) : "—" },
    { label: "Total tokens", value: fmt(totalTokens) },
    { label: "Sessions", value: fmt(totalSessions ?? 0) },
    { label: "Active days", value: `${activeDates.length}/${spanDays}` },
    {
      label: "Most active day",
      value: mostActive
        ? new Date(`${mostActive.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "—",
    },
    { label: "Longest session", value: longestSession ? formatDuration(longestSession.duration) : "—" },
    { label: "Longest streak", value: `${longestStreak} days` },
    { label: "Current streak", value: `${currentStreak} days` },
    { label: "Input tokens", value: fmt(totals.input) },
    { label: "Output tokens", value: fmt(totals.output) },
    { label: "Cache read", value: fmt(totals.cacheRead) },
    { label: "Cache write", value: fmt(totals.cacheWrite) },
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
