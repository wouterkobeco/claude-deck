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

// A record that says "the daemon was watching at this moment", and nothing
// else. Change-only logging cannot distinguish a machine that was asleep from
// one that was merely quiet — five idle sessions overnight produce exactly as
// many records as a daemon that is not running, which is none — and the
// difference is the whole of whether "nobody was working" is a finding or an
// artefact. So the daemon says so on its own timer, and `concurrency` reads
// coverage off the record stream rather than guessing at it.
//
// Cheap enough not to think about: one line every TICK_MS, 288 a day, against
// the state log's own few thousand.
export const TICK = "tick";
export const TICK_MS = 300_000;

/** Append one coverage record. Best-effort: a lost tick is a gap in a chart. */
export function recordTick(now = Date.now(), root = CLAUDE_DIR) {
  try {
    appendFileSync(fileIn(root), JSON.stringify({ ts: now, kind: TICK }) + "\n");
  } catch {
    // Same as a lost transition: the next tick writes again.
  }
}

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
          if (typeof rec?.ts !== "number") return [];
          return typeof rec.id === "string" || rec.kind === TICK ? [rec] : [];
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
    if (rec.kind === TICK) continue; // coverage, not a session
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

// A sample lands inside an outage when the log's own records straddle it by
// more than this. `TICK` is what makes that a fact rather than a guess: a
// running daemon writes one every TICK_MS whether or not anything changed, so
// three missed ticks is a daemon that was not running. Kept at three rather
// than one so a poll that lost a write, or a machine briefly too busy to get
// there, does not punch a hole in the chart.
//
// It stays a threshold rather than a strict "was there a tick" test because
// history predating the ticks has to keep reading sensibly: on a log with no
// ticks in it this degrades to the heuristic it replaced — quiet longer than
// this is treated as unobserved — which is wrong only for a machine left idle
// with sessions open, and wrong in the safe direction.
export const OUTAGE_MS = 3 * TICK_MS;
// How often concurrency is sampled, at the finest bucket. Fine enough that a
// session that ran for half an hour cannot fall between two samples, coarse
// enough that a day is under three hundred of them.
//
// Coarser buckets sample proportionally coarser — a month of 5-minute samples
// against every interval in it is tens of millions of comparisons for a chart
// whose bars are a day wide. `samplesFor` keeps it at a dozen samples per
// bucket, so the cost of a chart is its column count rather than its span. The
// honest cost: a spike shorter than the sample interval can be missed, which
// is the resolution a day-wide bar was always claiming anyway.
export const SAMPLE_MS = 300_000;
const samplesFor = (step) => Math.max(SAMPLE_MS, Math.round(step / 12));

/**
 * How many sessions were in each state at once, as a peak per `step`-wide
 * bucket.
 *
 * `summarise` answers "how long", which says nothing about overlap: eight hours
 * of busy is one session all day or eight at once, and those are different
 * machines. This walks the same intervals with a sampling clock instead and
 * reports the high-water mark per hour.
 *
 * **Unobserved time is reported as unobserved, never as duration.** The log
 * records changes a *running* daemon saw, so a sleep or a restart leaves one
 * interval spanning the gap — and a naive sweep counts the last known state
 * straight across it, which reads as six sessions working all night. Samples
 * inside a gap longer than `OUTAGE_MS` are dropped, and each hour carries how
 * many samples it actually got so a caller can show the difference rather than
 * average it away.
 *
 * `states` is the split at the busiest observed sample, not a peak per state.
 * Per-state peaks read as the obvious thing and are unstackable: the maximum
 * busy and the maximum idle happen at different minutes, so they sum to more
 * than the hour ever held and a stacked bar drawn from them runs past the end
 * of its own track. The composition at one instant sums to `any` by
 * construction. The cost is that a session blocked at a quieter minute of a
 * busy hour is not in this chart — it is in the blocked column of the table
 * below, which is the place that question is actually asked.
 *
 * `now` is an argument for the same reason it is in `summarise`: the last
 * record of a live session is an open interval that runs to it, and a check
 * cannot reproduce a clock.
 */
export function concurrency(records, from, to, now, step = 3600000) {
  const byId = new Map();
  for (const rec of records) {
    if (rec.kind === TICK) continue; // coverage, not a session
    if (!byId.has(rec.id)) byId.set(rec.id, []);
    byId.get(rec.id).push(rec);
  }
  const intervals = [];
  for (const list of byId.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      if (list[i].state === GONE) continue;
      intervals.push({ start: list[i].ts, end: list[i + 1] ? list[i + 1].ts : now, state: list[i].state });
    }
  }

  // Gaps in the log itself, from the timestamps of the records rather than
  // from the intervals: an interval is exactly what spans a gap, so asking it
  // is circular.
  const stamps = [...new Set(records.map((r) => r.ts))].sort((a, b) => a - b);
  const outages = [];
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] - stamps[i - 1] > OUTAGE_MS) outages.push([stamps[i - 1], stamps[i]]);
  }
  // Before the first record and after the last one, nothing was being watched
  // either — an empty log means the whole window is unobserved, not idle.
  outages.push([-Infinity, stamps[0] ?? Infinity], [stamps[stamps.length - 1] ?? -Infinity, Infinity]);
  const unobserved = (t) => outages.some(([a, b]) => t > a && t < b);

  const rows = new Map();
  const start = Math.floor(from / step) * step;
  for (let h = start; h < to; h += step) {
    rows.set(h, { hour: h, samples: 0, any: 0, states: {} });
  }
  const sample = samplesFor(step);
  for (let t = start; t < to; t += sample) {
    const row = rows.get(Math.floor(t / step) * step);
    if (!row || unobserved(t)) continue;
    row.samples++;
    const counts = {};
    let any = 0;
    for (const iv of intervals) {
      if (iv.start > t || iv.end <= t) continue;
      counts[iv.state] = (counts[iv.state] ?? 0) + 1;
      any++;
    }
    if (any > row.any) {
      row.any = any;
      row.states = counts;
    }
  }
  return [...rows.values()];
}
