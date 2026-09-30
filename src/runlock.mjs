/**
 * A remote test queue on the deck: `runlock status --json` on a remote host
 * (kob-backend's scripts/runlock, a machine-wide queue whose lane is a budget
 * of core slots), folded into one key that exists only while the box is busy,
 * and a board of one tile per run holding cores or waiting for them.
 *
 * Pure: the ssh call is `fetchRunlock` in remote-fs.mjs, the drawing is
 * `renderQueue` in render.mjs. Everything here is checked by
 * scripts/runlock-check.mjs.
 */
import { formatAge } from "./render.mjs";

// How long the head of the queue may wait before the key turns red: past this
// something is usually wedged (a stale holder, a cancelled CI job), not busy.
export const STUCK_AFTER_S = 600;

// Remote output is text another machine wrote. Every field is coerced to the
// type the key needs and bounded, so a strange value can only look strange.
const str = (v, max = 60) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : v == null ? "" : String(v).slice(0, max));
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The runlock document, or null when it is not one this understands. */
export function parseRunlockStatus(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || doc.schema !== 1 || !Array.isArray(doc.lanes)) return null;
  const run = (r, age) => ({
    requestor: str(r?.requestor) || "?",
    label: str(r?.label, 80),
    cores: num(r?.cores),
    age: num(r?.[age]),
    // The Claude Code session that started it, when runlock recorded one
    // (kob-backend #1849): what lets its session's key carry a pill.
    session: typeof r?.session === "string" && /^[0-9A-Za-z-]{8,64}$/.test(r.session) ? r.session : null,
  });
  return {
    host: str(doc.host, 30),
    lanes: doc.lanes
      .filter((l) => l && typeof l === "object")
      .map((l) => ({
        lane: str(l.lane, 30),
        capacity: num(l.capacity),
        free: num(l.free),
        holders: Array.isArray(l.holders) ? l.holders.map((h) => run(h, "running_s")) : [],
        waiters: Array.isArray(l.waiters) ? l.waiters.map((w) => run(w, "waiting_s")) : [],
      })),
  };
}

/**
 * What the key and board show, or null when the box is idle — which is what
 * makes the key appear only while it is busy. Holders and waiters are pooled
 * across lanes (a box has one set of cores however it is split); the budget is
 * the default lane's, where every caller queues today.
 */
export function queueSummary(doc) {
  if (!doc) return null;
  const holders = doc.lanes.flatMap((l) => l.holders);
  const waiters = doc.lanes.flatMap((l) => l.waiters);
  if (!holders.length && !waiters.length) return null;
  const lane = doc.lanes.find((l) => l.lane === "default") ?? doc.lanes[0];
  const capacity = lane?.capacity ?? null;
  const free = lane?.free ?? null;
  return {
    host: doc.host,
    capacity,
    free,
    holders,
    waiters,
    // The head is the longest waiter: the one runlock admits next.
    headWait: waiters.reduce((m, w) => Math.max(m, w.age ?? 0), 0),
  };
}

/** The key's face: `tone` picks the colour, the rest are its three lines and bar. */
export function queueKey(summary) {
  const { host, capacity, free, holders, waiters, headWait } = summary;
  const used = capacity != null && free != null ? capacity - free : null;
  const pct = used != null && capacity ? Math.round((used / capacity) * 100) : null;
  const title = host || "QUEUE";
  if (!waiters.length) {
    return {
      tone: "running",
      title,
      big: used != null ? `${used}/${capacity}` : `${holders.length}`,
      line: `${holders.length} RUNNING`,
      pct,
    };
  }
  return {
    tone: headWait >= STUCK_AFTER_S ? "stuck" : "queued",
    title,
    big: `${waiters.length}`,
    line: `QUEUED ${formatAge(headWait)}`.trim(),
    pct,
  };
}

/** One tile per run: holders first (what the cores are doing), then the queue in order. */
export function queueTiles(summary) {
  // `ci:kob-trace` is two facts, and the caps title only fits one: the name
  // goes on top, the kind (ci, repo, claude) leads the small line.
  const tile = (r, tone) => {
    const at = r.requestor.indexOf(":");
    const kind = at > 0 ? r.requestor.slice(0, at) : "";
    return {
      tone,
      title: at > 0 ? r.requestor.slice(at + 1) : r.requestor,
      big: r.cores != null ? `${r.cores}c` : "?",
      line: kind ? `${kind} · ${r.label}` : r.label,
      age: formatAge(r.age ?? NaN),
    };
  };
  return [...summary.holders.map((h) => tile(h, "running")), ...summary.waiters.map((w) => tile(w, "queued"))];
}

/**
 * Which sessions have a run on a busy queue, as the pill renderKey draws in a
 * key's foot row: `{ kind: "queued", text: "Q 4m" }` while it waits for cores,
 * `{ kind: "running", text: "RUN 3m" }` while it holds them. A session with runs
 * in both states shows the wait: that is the one worth knowing about.
 */
export function runsBySession(queues) {
  const out = new Map();
  for (const { summary } of queues) {
    for (const h of summary.holders) {
      if (h.session && !out.has(h.session)) out.set(h.session, { kind: "running", text: `RUN ${formatAge(h.age ?? NaN)}`.trim() });
    }
    for (const w of summary.waiters) {
      if (w.session) out.set(w.session, { kind: "queued", text: `Q ${formatAge(w.age ?? NaN) || "…"}` });
    }
  }
  return out;
}

