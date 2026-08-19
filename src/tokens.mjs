// What the tokens went on: hourly totals lifted out of Claude Code's
// transcripts, into a log that outlives them.
//
// Every assistant message carries `message.usage` next to an ISO timestamp, so
// the whole history is already on disk — but only for a while. Claude Code
// deletes transcripts past `cleanupPeriodDays`, which defaults to 30, and it is
// doing it: the oldest transcript on this machine when this was written was
// exactly 32 days old. So a page that reads transcripts live can never answer
// anything about last quarter, no matter how it is cached. Copying the numbers
// out is the only way to keep them.
//
// A fifth file, by the bar CLAUDE.md sets: an append log with its own retention
// and its own reader, and nothing that already exists can hold it. It is the
// second thing the daemon writes on its own schedule rather than in answer to a
// press — history.mjs was the first, and this one is its sibling in every way
// except that its source is a directory of other people's files rather than the
// board's own state.
//
// Sixth file, and it is a bookmark rather than data: `streamdeck-tokens.pos`
// is which byte of each transcript has already been counted. It cannot live in
// the log — a bookmark is rewritten on every pass and the log is only ever
// appended to — and without it every pass would re-read 2GB and double every
// total.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const logIn = (root) => join(root, "streamdeck-tokens.jsonl");
const posIn = (root) => join(root, "streamdeck-tokens.pos");

// A year, against history.mjs's month. These records are hourly buckets rather
// than one per event — measured at a few tens of KB per working day, where the
// state log runs at 250KB — so the same disk buys an order of magnitude more
// past. Keeping longer than the transcripts is the entire reason this file
// exists, so the number has to be well clear of Claude Code's 30-day cleanup.
export const RETENTION_DAYS = 365;

export const HOUR_MS = 3600_000;

/**
 * The fields worth keeping from one `message.usage`, and no others.
 *
 * Cache creation is split 5m/1h because those two are billed differently, and
 * the split is not recoverable once the transcript is gone — the same reason
 * `model` is kept rather than a "was it opus" flag. Thinking tokens are a
 * subset of `output`, kept because they answer "what did the reasoning cost"
 * and cost nothing to carry. Everything else in that object (`service_tier`,
 * `iterations`, `inference_geo`, the server-tool counters) is either derivable,
 * constant here, or answers a question nobody has asked; a field added later
 * simply starts from the day it was added, which is the honest trade for not
 * keeping all of it.
 */
function usageOf(u) {
  return {
    calls: 1,
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    think: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    // Pre-`cache_creation` transcripts only carry the flat total. Falling back
    // to it under 5m rather than dropping it keeps old rows countable; the
    // split is simply unknown that far back, and 5m is what it was.
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

const METRICS = ["calls", "in", "out", "think", "cacheWrite5m", "cacheWrite1h", "cacheRead"];

// One bucket per hour per cwd per model per kind. `sub` is whether the
// transcript sat under a `subagents/` directory — an Agent-tool subagent
// writes there and nowhere else, and it turned out to be 38% of all calls on
// this machine, which is exactly the split the deck cannot show you.
const keyOf = (b) => `${b.hour}|${b.cwd}|${b.model}|${b.sub ? 1 : 0}`;

function addTo(buckets, hour, cwd, model, sub, usage) {
  const b = { hour, cwd, model, sub };
  const key = keyOf(b);
  const found = buckets.get(key) ?? Object.assign(b, Object.fromEntries(METRICS.map((m) => [m, 0])));
  for (const m of METRICS) found[m] += usage[m];
  buckets.set(key, found);
}

/**
 * Every `.jsonl` under `projectsRoot`, at any depth.
 *
 * Depth matters: a subagent's transcript is four levels down
 * (`<slug>/<parent id>/subagents/agent-*.jsonl`), and remote-fs.mjs already
 * has the scar from a glob that could not reach it.
 */
async function transcriptPaths(projectsRoot) {
  try {
    return (await readdir(projectsRoot, { recursive: true })).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return []; // no projects directory — nothing has ever run here
  }
}

function readPositions(root) {
  try {
    const parsed = JSON.parse(readFileSync(posIn(root), "utf8"));
    // Same rule as readAccents: a half-written or hand-edited file must not
    // put arbitrary values into arithmetic that decides what gets counted.
    return new Map(Object.entries(parsed).filter(([, v]) => typeof v === "number" && v >= 0));
  } catch {
    return new Map(); // first run, or unreadable — backfill from byte 0
  }
}

/**
 * Count the bytes of every transcript that have appeared since the last pass.
 *
 * Incremental by byte offset rather than by mtime: a transcript is appended to
 * for hours, so "changed since last time" is true of a 1.2MB file that grew by
 * one line, and re-reading it whole would double every total in it. Transcripts
 * only ever grow, so the offset is a safe bookmark — a file that has *shrunk*
 * is a different file under the same name (a session id reused, or a truncated
 * write) and is re-read from zero.
 *
 * A partial trailing line is left for next time: this reads a file another
 * process is appending to, so the last line is routinely half-written. The
 * cursor advances only over bytes that ended in a newline, which is what makes
 * that safe rather than lossy.
 *
 * Returns how many buckets were appended. Best-effort throughout, like every
 * other reader here: one unreadable transcript is skipped, not fatal.
 */
export async function collectTokens({ now = Date.now(), root = CLAUDE_DIR, projectsRoot = join(root, "projects") } = {}) {
  const previous = readPositions(root);
  // Rebuilt from the paths that exist *now* rather than mutated in place: Claude
  // Code deletes transcripts past its cleanup period, and a map that only ever
  // gained keys would carry a bookmark per transcript this machine has ever
  // written, forever, for files nothing will read again.
  const positions = new Map();
  const buckets = new Map();
  let moved = false;

  for (const name of await transcriptPaths(projectsRoot)) {
    const path = join(projectsRoot, name);
    let size;
    try {
      ({ size } = await stat(path));
    } catch {
      continue; // vanished between readdir and stat
    }
    const seen = previous.get(name) ?? 0;
    const from = seen > size ? 0 : seen;
    positions.set(name, from);
    if (from >= size) continue;

    let text;
    let fh;
    try {
      fh = await open(path);
      const buf = Buffer.alloc(size - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      continue;
    } finally {
      await fh?.close().catch(() => {});
    }

    const complete = text.lastIndexOf("\n");
    if (complete < 0) continue; // nothing but a partial line so far
    const sub = name.includes("/subagents/");
    for (const line of text.slice(0, complete).split("\n")) {
      // Cheap pre-filter, then the line's own parsed JSON decides — the same
      // rule readTranscriptSignals lives by, and for the same reason: a
      // transcript quotes tool output verbatim, so "usage" appears inside
      // prose and inside other transcripts printed into this one.
      if (!line.includes('"usage"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      const ts = Date.parse(rec?.timestamp ?? "");
      if (!u || typeof u !== "object" || Number.isNaN(ts)) continue;
      const usage = usageOf(u);
      // A `<synthetic>` message — an API error, an interrupt, a cancelled turn
      // — carries a usage object of nothing but zeroes. Counting those buys a
      // bucket per hour per session saying nothing happened, which is a third
      // of the rows on this machine's first backfill.
      if (!METRICS.some((m) => m !== "calls" && usage[m] > 0)) continue;
      addTo(buckets, Math.floor(ts / HOUR_MS) * HOUR_MS, rec.cwd ?? "", rec.message?.model ?? "", sub, usage);
    }
    positions.set(name, from + Buffer.byteLength(text.slice(0, complete + 1), "utf8"));
    moved = true;
  }

  if (!moved) return 0;
  try {
    if (buckets.size) {
      appendFileSync(logIn(root), [...buckets.values()].map((b) => JSON.stringify(b)).join("\n") + "\n");
    }
    // Written after the log, never before: a crash between the two re-counts a
    // few lines on the next pass, where the other order would drop them for
    // good. Over-counting is visible and fixable; a hole is neither.
    writeFileSync(posIn(root), JSON.stringify(Object.fromEntries(positions)));
  } catch {
    // Out of disk, or a read-only home. The next pass tries again from the
    // bookmark that did get written.
    return 0;
  }
  return buckets.size;
}

/** Every parseable bucket, in file order. A bad line is skipped, not fatal. */
export function readTokens(root = CLAUDE_DIR) {
  try {
    return readFileSync(logIn(root), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const rec = JSON.parse(line);
          return typeof rec?.hour === "number" ? [rec] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return []; // nothing collected yet
  }
}

/**
 * Hourly totals over `[from, to)`, oldest first, with every hour in the window
 * present even when nothing ran in it.
 *
 * The gaps are the point: a bar chart that silently omits an idle hour draws a
 * busy night out of four scattered messages. Buckets are summed rather than
 * replaced, because a pass appends a partial hour and the next pass appends the
 * rest of it — `compactTokens` merges those eventually, and this must be right
 * before it has.
 */
export function summariseTokens(records, from, to) {
  const start = Math.floor(from / HOUR_MS) * HOUR_MS;
  const hours = new Map();
  for (let h = start; h < to; h += HOUR_MS) {
    hours.set(h, Object.fromEntries([["hour", h], ["subCalls", 0], ...METRICS.map((m) => [m, 0])]));
  }
  for (const rec of records) {
    const row = hours.get(rec.hour);
    if (!row) continue;
    for (const m of METRICS) row[m] += rec[m] ?? 0;
    if (rec.sub) row.subCalls += rec.calls ?? 0;
  }
  return [...hours.values()];
}

/**
 * Totals grouped by one bucket field, biggest first — `model` for what the
 * spend went on, `cwd` for which project it went on.
 */
export function groupTokens(records, field, from, to) {
  const groups = new Map();
  for (const rec of records) {
    if (rec.hour < from || rec.hour >= to) continue;
    const key = rec[field] ?? "";
    const row = groups.get(key) ?? Object.fromEntries([[field, key], ...METRICS.map((m) => [m, 0])]);
    for (const m of METRICS) row[m] += rec[m] ?? 0;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => b.out - a.out);
}

/**
 * Drop buckets past the retention window and merge what's left.
 *
 * The merge is not housekeeping — it is what keeps the log from growing with
 * the *poll rate* instead of with time. Every pass appends a fresh bucket for
 * the hour in progress, so a five-minute cadence writes a dozen rows for one
 * hour; summing them is correct but storing them forever is not. Same shape as
 * trimHistory: a whole-file rewrite, so it runs at startup and then once a day.
 *
 * Returns how many records the file lost, so the caller can say nothing
 * happened. A failed rewrite leaves the original, which still summarises
 * correctly — just larger.
 */
export function compactTokens(now = Date.now(), root = CLAUDE_DIR) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  const records = readTokens(root);
  const merged = new Map();
  for (const rec of records) {
    if (rec.hour < cutoff) continue;
    const key = keyOf(rec);
    const row = merged.get(key);
    if (!row) {
      merged.set(key, { ...rec });
      continue;
    }
    for (const m of METRICS) row[m] = (row[m] ?? 0) + (rec[m] ?? 0);
  }
  if (merged.size === records.length) return 0;
  try {
    const out = [...merged.values()].sort((a, b) => a.hour - b.hour);
    writeFileSync(logIn(root), out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""));
    return records.length - merged.size;
  } catch {
    return 0;
  }
}
