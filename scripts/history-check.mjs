// Verifies the state-history log: a record only when something changed, a
// closing record when a session ends, and the duration maths — including the
// open interval and the window clipping, which are where a summary silently
// starts lying.
// Run: node scripts/history-check.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GONE, RETENTION_DAYS, readHistory, recordStates, startOfDay, summarise, trimHistory } from "../src/history.mjs";

const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const dir = mkdtempSync(join(tmpdir(), "streamdeck-history-"));
const A = "/projects/alpha";
const B = "/projects/beta";
const s = (id, folder, state, extra = {}) => ({ session_id: id, folder, state, nested: false, ...extra });

// --- recording -------------------------------------------------------------

const prev = new Map();
eq(recordStates([s("a", A, "busy")], prev, 1000, dir), 1, "a new session writes one record");
// The point of the whole design: a session sitting busy for an hour is one
// record, not one per 2s poll.
eq(recordStates([s("a", A, "busy")], prev, 2000, dir), 0, "an unchanged state writes nothing");
eq(recordStates([s("a", A, "waiting")], prev, 3000, dir), 1, "a change writes one");

// A subagent's time belongs to its parent's project through the parent's own
// state; counting it as well would double-count every minute a parent spent
// waiting on one.
eq(recordStates([s("a", A, "waiting"), s("sub", A, "busy", { nested: true })], prev, 4000, dir), 0, "nested sessions are not recorded");

// Without a closing record the final state of every session that ever ran
// counts up to now, forever.
eq(recordStates([], prev, 5000, dir), 1, "a session that disappears writes a closing record");
eq(recordStates([], prev, 6000, dir), 0, "and only once");

const written = readHistory(dir);
eq(written.map((r) => [r.ts, r.id, r.state]), [
  [1000, "a", "busy"],
  [3000, "a", "waiting"],
  [5000, "a", GONE],
], "the log is what happened, in order");
eq(written[0].folder, A, "records carry the folder they are attributed to");

// --- durations -------------------------------------------------------------

// busy 1000->3000 (2s), waiting 3000->5000 (2s), then gone.
eq(summarise(written, 9000, 0), { [A]: { busy: 2000, waiting: 2000 } }, "a duration runs to the next record");

// The last record of a live session has no successor: it is still in that
// state, so it runs to now. Getting this wrong makes every current session
// contribute zero, which reads as "nothing happened today".
const live = [{ ts: 1000, id: "b", folder: B, state: "busy" }];
eq(summarise(live, 5000, 0), { [B]: { busy: 4000 } }, "an open interval runs to now");
eq(summarise([{ ts: 1000, id: "b", folder: B, state: GONE }], 5000, 0), {}, "a gone record contributes nothing");

// Clipped, not counted whole: a session busy since yesterday owes today only
// today's share.
eq(summarise(live, 5000, 3000), { [B]: { busy: 2000 } }, "an interval is clipped to the window's start");
eq(summarise([{ ts: 1000, id: "b", folder: B, state: "busy" }, { ts: 9000, id: "b", folder: B, state: "idle" }], 5000, 0),
  { [B]: { busy: 4000 } }, "and to its end");
eq(summarise(live, 500, 0), {}, "a window ending before the record is empty");

// Two sessions in one project sum; two projects stay apart. Attribution is by
// folder because session ids are ephemeral and the question is about projects.
const two = [
  { ts: 0, id: "x", folder: A, state: "busy" },
  { ts: 0, id: "y", folder: A, state: "busy" },
  { ts: 0, id: "z", folder: B, state: "waiting" },
];
eq(summarise(two, 1000, 0), { [A]: { busy: 2000 }, [B]: { waiting: 1000 } }, "sessions sum per project");

// Records arriving out of order must still pair up — the file is appended by
// one process, but nothing in the format guarantees it.
const shuffled = [
  { ts: 3000, id: "q", folder: A, state: "idle" },
  { ts: 1000, id: "q", folder: A, state: "busy" },
];
eq(summarise(shuffled, 4000, 0), { [A]: { busy: 2000, idle: 1000 } }, "records are sorted per session before pairing");

// --- robustness ------------------------------------------------------------

// A poll killed mid-append leaves a half-written last line. One bad line must
// not cost the other 30 days.
writeFileSync(join(dir, "streamdeck-history.jsonl"), '{"ts":1,"id":"a","state":"busy"}\n{"ts":2,"id":"a"\n');
eq(readHistory(dir).length, 1, "a truncated last line is skipped, not fatal");
eq(readHistory(join(dir, "nope")), [], "a missing file reads as no history");

// --- retention -------------------------------------------------------------

const now = 1_000_000_000_000;
const old = now - (RETENTION_DAYS + 1) * 86400000;
writeFileSync(
  join(dir, "streamdeck-history.jsonl"),
  [{ ts: old, id: "a", folder: A, state: "busy" }, { ts: now - 1000, id: "b", folder: A, state: "busy" }]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n"
);
eq(trimHistory(now, dir), 1, "records past the retention window are dropped");
eq(readHistory(dir).map((r) => r.id), ["b"], "and the rest survive");
eq(trimHistory(now, dir), 0, "trimming again drops nothing");
// The rewrite must leave a file the appender can extend — a missing trailing
// newline would glue the next record onto the last one.
eq(readFileSync(join(dir, "streamdeck-history.jsonl"), "utf8").endsWith("\n"), true, "the trimmed file still ends in a newline");
recordStates([s("c", A, "busy")], new Map(), now, dir);
eq(readHistory(dir).map((r) => r.id), ["b", "c"], "and appending after a trim still parses");

// --- day boundary ----------------------------------------------------------

const noon = new Date(2026, 7, 17, 12, 30, 0).getTime();
const midnight = new Date(2026, 7, 17, 0, 0, 0, 0).getTime();
eq(startOfDay(noon), midnight, "today starts at local midnight");
eq(startOfDay(midnight), midnight, "and midnight is already the start of its own day");

rmSync(dir, { recursive: true, force: true });
console.log("OK: change-only records, closing records, duration and clipping, retention");
