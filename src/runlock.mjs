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
// Signed: a run past its estimate reports negative time remaining, and that is
// the one case where the sign is the news.
const signed = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
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
    // The floor of an elastic request: a run asking for 4-16 starts on 4.
    coresMin: num(r?.cores_min),
    age: num(r?.[age]),
    // Runlock's own estimate: time left for a holder, until it starts for a waiter.
    eta: signed(r?.remaining_s ?? r?.starts_in_s),
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
  // Every lane's budget, summed: a run on any lane holds cores, and the
  // default lane alone read 0/16 beside a run that sat on the prep lane. The
  // split per lane is `lanes`, for the board.
  const lanes = doc.lanes.filter((l) => l.capacity != null && l.free != null).map((l) => ({ lane: l.lane, capacity: l.capacity, free: l.free }));
  const capacity = lanes.length ? lanes.reduce((n, l) => n + l.capacity, 0) : null;
  const free = lanes.length ? lanes.reduce((n, l) => n + l.free, 0) : null;
  return {
    host: doc.host,
    capacity,
    free,
    lanes,
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

/**
 * The cores budget as tiles for the board's bottom-right corner, left to
 * right: each lane when there is more than one, then the total last, nearest
 * the corner. One lane is just that lane.
 */
export function queueBudget(summary) {
  const budget = (title, capacity, free) => {
    const used = capacity - free;
    const pct = capacity ? Math.round((used / capacity) * 100) : 0;
    return { tone: summary.waiters.length ? "queued" : "running", title, big: `${used}/${capacity}`, line: `${pct}% of cores`, pct, age: "" };
  };
  const lanes = (summary.lanes ?? []).map((l) => budget(l.lane, l.capacity, l.free));
  return lanes.length > 1 ? [...lanes, budget("TOTAL", summary.capacity, summary.free)] : lanes;
}

/** One tile per run: holders first (what the cores are doing), then the queue in order. */
export function queueTiles(summary) {
  // `ci:kob-trace` is two facts, and the caps title only fits one: the name
  // goes on top, the kind (ci, repo, claude) leads the small line.
  const tile = (r, tone, pos = null) => {
    const holding = pos == null;
    // A running job shows what is left, not what has elapsed; with no estimate
    // from runlock the elapsed time is all there is, and it stays.
    const left = holding && r.eta != null;
    const eta = r.eta == null || holding ? "" : `starts ~${formatAge(Math.max(0, r.eta)) || "now"}`;
    const at = r.requestor.indexOf(":");
    const kind = at > 0 ? r.requestor.slice(0, at) : "";
    return {
      tone,
      title: at > 0 ? r.requestor.slice(at + 1) : r.requestor,
      big: r.cores == null ? "?" : !holding ? (r.coresMin != null && r.coresMin < r.cores ? `${r.coresMin}-${r.cores}c` : `${r.cores}c`) : `${r.cores}c`,
      line: kind ? `${kind} · ${r.label}` : r.label,
      // How long it has run or waited is the news, so it gets the foot of the
      // tile in large type, the main board's pill.
      age: "",
      wait: left ? (r.eta >= 0 ? `${formatAge(r.eta) || "0s"} left` : `${formatAge(-r.eta)} over`) : formatAge(r.age ?? NaN) || "…",
      eta,
      // How far through its estimate a running job is, for the web page's bar.
      frac: holding && r.eta != null && r.age != null ? Math.min(1, r.age / Math.max(1, r.age + Math.max(0, r.eta))) : null,
      pos,
    };
  };
  return [...summary.holders.map((h) => tile(h, "running")), ...summary.waiters.map((w, i) => tile(w, "queued", i + 1))];
}

/**
 * Which sessions have a run on a busy queue, as the pill renderKey draws in a
 * key's foot row: `{ kind: "queued", text: "Q2 4m" }` (second in line) while it waits for cores,
 * `{ kind: "running", text: "RUN 3m" }` while it holds them. A session with runs
 * in both states shows the wait: that is the one worth knowing about.
 */
export function runsBySession(queues) {
  const out = new Map();
  for (const { summary } of queues) {
    for (const h of summary.holders) {
      if (h.session && !out.has(h.session)) out.set(h.session, { kind: "running", text: `RUN ${formatAge(h.age ?? NaN)}`.trim() });
    }
    // Q1 is next in line. The position is within this host's queue as
    // runlock lists it (head first), so a session waiting twice shows the
    // later entry's — the same last-wins the age already had.
    summary.waiters.forEach((w, i) => {
      if (w.session) out.set(w.session, { kind: "queued", text: `Q${i + 1} ${formatAge(w.age ?? NaN) || "…"}` });
    });
  }
  return out;
}


/**
 * Every run a session has on a busy queue, as chips for the web board:
 * waiting ones first in queue order (`Q2 4m`), then holding ones (`RUN 3m`),
 * at most three. The deck's key has room for one pill and keeps `runsBySession`.
 */
export function chipsBySession(queues, max = 3) {
  const out = new Map();
  for (const { summary } of queues) {
    const mine = (id) => out.get(id) ?? out.set(id, []).get(id);
    summary.waiters.forEach((w, i) => w.session && mine(w.session).push({ kind: "queued", text: `Q${i + 1} ${formatAge(w.age ?? NaN) || "…"}`, at: 0 }));
    for (const h of summary.holders) if (h.session) mine(h.session).push({ kind: "running", text: `RUN ${formatAge(h.age ?? NaN)}`.trim(), at: 1 });
  }
  for (const [id, chips] of out) out.set(id, chips.sort((a, b) => a.at - b.at).slice(0, max).map(({ kind, text }) => ({ kind, text })));
  return out;
}

/**
 * Runs that ended without finishing, from the host's history rows (one JSON
 * object per line, already grepped down to the interesting ones): ran out of
 * `--timeout`, left the queue before starting, or were killed by a signal.
 * Newest first, within `maxAgeS`. Text from another machine, so every field is
 * coerced like the status document's.
 */
export function parseEnded(text, now = Date.now(), maxAgeS = 86400, max = 20) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const ended =
      r.status === "timeout" ? (r.started_at ? "timed out while running" : "timed out waiting for cores")
      : r.status === "cancelled" ? "left the queue before starting"
      : r.termination_kind === "signalled" ? `killed by signal ${num(r.signal) ?? "?"}`
      : null;
    if (!ended) continue;
    const at = Date.parse(r.finished_at ?? r.enqueued_at) + (r.finished_at ? 0 : (num(r.wait_seconds) ?? 0) * 1000);
    if (!Number.isFinite(at) || now - at > maxAgeS * 1000) continue;
    out.push({ at, ended, requestor: str(r.requestor) || "?", label: str(r.label, 80), ranS: num(r.run_seconds), waitedS: num(r.wait_seconds), session: typeof r.session === "string" && /^[0-9A-Za-z-]{8,64}$/.test(r.session) ? r.session : null });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}
