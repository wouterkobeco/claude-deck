// Verifies the state-history log: a record only when something changed, a
// closing record when a session ends, and the duration maths — including the
// open interval and the window clipping, which are where a summary silently
// starts lying.
// Run: node scripts/history-check.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GONE, OUTAGE_MS, RETENTION_DAYS, TICK, TICK_MS, concurrency, memorySeries, readHistory, recordStates, recordTick, startOfDay, summarise, trimHistory } from "../src/history.mjs";

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

// --- concurrency -----------------------------------------------------------

// How many at once, which is the question durations cannot answer: eight hours
// of busy is one session all day or eight at once.
{
  const H = Date.parse("2026-08-18T09:00:00.000Z");
  // Ticks are what say the daemon was watching. Without them a quiet stretch
  // between two changes is indistinguishable from a sleeping machine, and the
  // sweep would honestly refuse to count the very samples this case is about.
  const ticks = Array.from({ length: 12 }, (_, i) => ({ ts: H + i * TICK_MS, kind: TICK }));
  const recs = [
    ...ticks,
    { ts: H + 60000, id: "a", folder: A, state: "busy" },
    { ts: H + 120000, id: "b", folder: A, state: "busy" },
    { ts: H + 180000, id: "c", folder: A, state: "requires_action" },
    { ts: H + 20 * 60000, id: "b", state: GONE },
    { ts: H + 50 * 60000, id: "a", folder: A, state: "idle" },
  ];
  const rows = concurrency(recs, H, H + 3600000, H + 55 * 60000);
  eq(rows.length, 1, "one row per hour in the window");
  eq(rows[0].any, 3, "three sessions at once is a peak of three");
  eq(rows[0].states.busy, 2, "with the split at that instant: two busy");
  eq(rows[0].states.requires_action, 1, "and one blocked");
  // The reason it is the split at one instant rather than a peak per state: a
  // stacked bar drawn from per-state maxima runs past the end of its own
  // track, because the busiest busy minute and the busiest idle minute are
  // different minutes.
  eq(
    Object.values(rows[0].states).reduce((a, b) => a + b, 0),
    rows[0].any,
    "the segments sum to the total exactly, so a stacked bar cannot overflow"
  );
}

// The failure this exists to prevent: the log only records what a *running*
// daemon saw, so a sleep leaves one interval spanning ten hours. A naive sweep
// counts the last known state straight across it and reads as a machine that
// worked all night. Unobserved time is reported as unobserved.
{
  const H = Date.parse("2026-08-18T09:00:00.000Z");
  const recs = [
    { ts: H, kind: TICK },
    { ts: H + 60000, id: "a", folder: A, state: "busy" },
    { ts: H + TICK_MS, kind: TICK },
    { ts: H + 2 * TICK_MS, kind: TICK },
    // Then no ticks for three hours — the daemon was not running.
    { ts: H + 3 * 3600000, kind: TICK },
    { ts: H + 3 * 3600000 + 60000, id: "a", folder: A, state: "busy" },
  ];
  const rows = concurrency(recs, H, H + 4 * 3600000, H + 3 * 3600000 + 120000);
  eq(rows.map((r) => r.samples > 0), [true, false, false, true], "the hours inside the gap got no samples");
  eq(rows[1].any, 0, "and report nothing rather than a session that was never seen");
  eq(rows[0].states.busy, 1, "while the observed hours are unaffected");
}

// A gap shorter than the threshold is ordinary quiet, not an outage: the daemon
// writes only on change, so nothing changing for a few minutes is the norm.
{
  const H = Date.parse("2026-08-18T09:00:00.000Z");
  const recs = [
    { ts: H + 60000, id: "a", folder: A, state: "busy" },
    { ts: H + 60000 + OUTAGE_MS - 60000, id: "a", folder: A, state: "idle" },
  ];
  eq(concurrency(recs, H, H + 3600000, H + 3600000)[0].samples > 0, true, "a sub-threshold quiet spell is still observed");
}

// A tick is coverage, never a session: it must not become an interval, a
// duration or a folder. Every reader that walks records has to skip it, and
// summarise is the one that would silently grow a phantom project.
{
  const H = Date.parse("2026-08-18T09:00:00.000Z");
  const recs = [{ ts: H, kind: TICK }, { ts: H, id: "a", folder: A, state: "busy" }];
  eq(Object.keys(summarise(recs, H + 60000, H)), [A], "a tick adds no folder to the summary");
  eq(concurrency(recs, H, H + 3600000, H + 60000)[0].any, 1, "and no session to the concurrency count");
}

// It round-trips through the real file, alongside the state records — one log,
// two kinds of line, and readHistory has to keep both.
{
  recordTick(now, dir);
  const kinds = readHistory(dir).map((r) => r.kind ?? "state");
  eq(kinds.includes(TICK), true, "a tick written to the log reads back as one");
}

// An empty log is a window nobody watched, not a window in which nothing ran.
eq(concurrency([], 0, 3600000, 3600000)[0].samples, 0, "no records means no observations");

rmSync(dir, { recursive: true, force: true });
console.log("OK: change-only records, closing records, duration and clipping, retention, concurrency");

// Memory rides on the tick: the bucket keeps its maximum, a tick without it
// is still a tick but not a sample, and a bucket with none draws unseen.
{
  const H0 = Date.UTC(2026, 7, 20, 9);
  const recs = [
    { ts: H0, kind: TICK, mem: 30, swap: 50, cl: 6000, cln: 17 },
    { ts: H0 + TICK_MS, kind: TICK, mem: 75, swap: 90, cl: 5000, cln: 12 },
    { ts: H0 + 2 * TICK_MS, kind: TICK },
    { ts: H0 + 3600000, id: "a", folder: "/p", state: "busy" },
  ];
  const series = memorySeries(recs, H0, H0 + 2 * 3600000);
  if (JSON.stringify(series) !== JSON.stringify([
    { hour: H0, pressure: 75, swap: 90, claudeMb: 6000, claudeCount: 17, samples: 2 },
    { hour: H0 + 3600000, pressure: 0, swap: 0, claudeMb: 0, claudeCount: 0, samples: 0 },
  ])) { console.error("FAILED memorySeries", series); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  recordTick(H0, dir, { pressure: 41.6, swap: 93.2, claude: { mb: 5400, count: 17 } });
  recordTick(H0 + TICK_MS, dir, { pressure: null, swap: null });
  const [a, b] = readHistory(dir);
  if (a.mem !== 42 || a.swap !== 93 || a.cl !== 5400 || a.cln !== 17 || "mem" in b || "cl" in b) { console.error("FAILED recordTick memory", a, b); process.exit(1); }
  console.log("OK: memory on the tick");
}
