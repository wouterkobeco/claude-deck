// Where the time goes: an append-only log of every session state change, and
// the per-project totals read back out of it.
//
// The daemon has watched every session's state every 2s since it was written
// and persisted none of it. Nothing else on the machine has that view —
// stats.mjs' all-time numbers come from another tool's cache — so "which
// project ate an hour of waiting for me to approve things" was unanswerable
// from data that was passing through here thirty times a minute.
//
// A fourth file rather than another key in streamdeck-accents.json, which is a
// record per project: this is an append log with its own retention and its own
// reader, which is the bar CLAUDE.md sets for adding one.
//
// Best-effort like every other writer here. A poll that can't append loses one
// transition, and a summary over a file that won't parse is an empty table —
// never an exception into the poll loop.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const fileIn = (root) => join(root, "streamdeck-history.jsonl");

// Measured at roughly 250KB per working day, so this caps the file around 7MB.
// Trimming is a rewrite, which is why it happens at startup and then once a
// day rather than on a timer.
export const RETENTION_DAYS = 30;

// "gone" is not a session state — it is the record that closes the last
// interval when a session ends. Without it the final state of every session
// that ever ran counts up to now, forever.
export const GONE = "gone";

/**
 * Append a record for every session whose state changed since the last call,
 * plus a `gone` record for every session that has disappeared.
 *
 * `previous` is the caller's own Map of `session_id -> state`, mutated in
 * place — the daemon keeps one for its lifetime. Passing it in rather than
 * holding module state is what lets the check drive this without a daemon.
 *
 * Only on change: a session sitting busy for an hour is one record, not 1,800.
 */
export function recordStates(sessions, previous, now = Date.now(), root = CLAUDE_DIR) {
  const lines = [];
  const seen = new Set();
  for (const s of sessions) {
    // A subagent's state belongs to its parent's key, not to a project's time:
    // counting both would double-count every minute the parent spent waiting
    // on it.
    if (s.nested) continue;
    seen.add(s.session_id);
    if (previous.get(s.session_id) === s.state) continue;
    previous.set(s.session_id, s.state);
    lines.push({ ts: now, id: s.session_id, folder: s.folder, host: s.host ?? null, state: s.state });
  }
  for (const [id, state] of previous) {
    if (seen.has(id) || state === GONE) continue;
    previous.set(id, GONE);
    lines.push({ ts: now, id, state: GONE });
  }
  if (lines.length === 0) return 0;
  try {
    appendFileSync(fileIn(root), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  } catch {
    // One lost transition. The next change writes again.
  }
  return lines.length;
}

/** Every parseable record, oldest first. A bad line is skipped, not fatal. */
export function readHistory(root = CLAUDE_DIR) {
  try {
    return readFileSync(fileIn(root), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const rec = JSON.parse(line);
          return typeof rec?.ts === "number" && typeof rec?.id === "string" ? [rec] : [];
        } catch {
          // A poll that died mid-append leaves a half-written last line.
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Time in each state per project, over `[from, now]`, as
 * `{ folder -> { state -> ms } }`.
 *
 * A record's duration runs to the next record *for the same session*. The last
 * one has no successor: if it is `gone` the session ended and it contributes
 * nothing, otherwise the session is still in that state and it runs to `now`.
 * That open interval is the whole reason this takes `now` rather than reading
 * the clock — a summary has to be reproducible for a check.
 *
 * Intervals are clipped to the window rather than counted whole, so a session
 * that has been busy since yesterday contributes only today's share to today.
 * Attributed by folder, never by session id: ids are ephemeral and the
 * question is which project the time went to.
 */
export function summarise(records, now, from) {
  const byId = new Map();
  for (const rec of records) {
    if (!byId.has(rec.id)) byId.set(rec.id, []);
    byId.get(rec.id).push(rec);
  }
  const totals = {};
  for (const list of byId.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (rec.state === GONE) continue;
      const end = list[i + 1] ? list[i + 1].ts : now;
      const start = Math.max(rec.ts, from);
      const stop = Math.min(end, now);
      if (stop <= start) continue;
      const folder = rec.folder ?? "";
      totals[folder] ??= {};
      totals[folder][rec.state] = (totals[folder][rec.state] ?? 0) + (stop - start);
    }
  }
  return totals;
}

/**
 * Drop records older than `RETENTION_DAYS` and rewrite the file.
 *
 * Returns how many were dropped so the caller can say nothing happened. A
 * rewrite that fails leaves the original in place, which is the right way for
 * this to fail: an oversized history still summarises correctly.
 */
export function trimHistory(now = Date.now(), root = CLAUDE_DIR) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  const records = readHistory(root);
  const keep = records.filter((r) => r.ts >= cutoff);
  if (keep.length === records.length) return 0;
  try {
    writeFileSync(fileIn(root), keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
    return records.length - keep.length;
  } catch {
    return 0;
  }
}

/** Local midnight for the day `now` falls in — the start of "today". */
export function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
