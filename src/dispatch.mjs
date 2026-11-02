/**
 * The agent queue on a remote host: `dispatch.mjs status --json` from
 * kob-dispatch (AI agents planning and building GitHub issues), folded into
 * one key on that host's queue board and a section of the web queue page.
 *
 * Pure: the ssh call is `fetchDispatch` in remote-fs.mjs, the key is drawn by
 * `renderQueue`, the page is queue-page.mjs. Checked by scripts/dispatch-check.mjs.
 */

import { queueKey } from "./runlock.mjs";

// Remote output is text another machine wrote, issue titles included: every
// field is coerced to the type it is shown as and bounded.
const str = (v, max = 120) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
// An issue number goes into a URL, so only a plain positive integer passes.
const issue = (v) => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : null);
const list = (v, max = 50) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object") : []);

export const ISSUE_URL = "https://github.com/wouterkobeco/kob-trace/issues/";

/** The status document, or null when it is not one (a host with no dispatcher answers nothing). */
export function parseDispatchStatus(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.leases)) return null;
  return {
    capacity: num(doc.capacity),
    leases: list(doc.leases)
      .map((l) => ({
        n: issue(l.n),
        kind: l.kind === "planner" || l.kind === "worker" ? l.kind : "agent",
        attempt: num(l.attempt) ?? 0,
        startedAt: num(l.startedAt),
        title: str(l.title),
        areas: (Array.isArray(l.areas) ? l.areas : []).slice(0, 6).map((a) => str(a, 30)).filter(Boolean),
        migration: l.migration === true,
      }))
      .filter((l) => l.n),
    waiting: list(doc.waiting).map((w) => ({ n: issue(w.n), reason: str(w.reason, 80), title: str(w.title) })).filter((w) => w.n),
    cards: list(doc.cards).map((c) => ({ n: issue(c.n), title: str(c.title) })).filter((c) => c.n),
    hold: doc.hold && typeof doc.hold === "object" ? { reason: str(doc.hold.reason, 120) } : null,
    lastTickAgeSeconds: num(doc.lastTickAgeSeconds),
  };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The key's face, for renderQueue: agents busy of capacity big, the queue on
 * the line (cards waiting for the owner too), the bar the busy share. Red while
 * the dispatcher is held, busy while any agent runs, dark when idle.
 */
export function agentsKey(doc) {
  const busy = doc.leases.length;
  const extra = [`${doc.waiting.length} queued`, doc.cards.length ? plural(doc.cards.length, "card") : null].filter(Boolean).join(" · ");
  return {
    tone: doc.hold ? "stuck" : busy ? "running" : "idle",
    title: "AGENTS",
    big: doc.capacity != null ? `${busy}/${doc.capacity}` : `${busy}`,
    line: doc.hold ? "HELD" : extra,
    pct: doc.capacity ? Math.min(100, Math.round((busy / doc.capacity) * 100)) : null,
  };
}

/** Whether a dispatcher has something to show on the main board: an agent at work, or a hold. */
export const agentsBusy = (doc) => !!doc && (doc.leases.length > 0 || !!doc.hold);

/**
 * The hosts that earn a queue key on the main board, one per host whichever
 * queue is busy: `[{ host, summary, agents }]`, busy test queues first in
 * their order, then hosts whose only news is their agents. `queues` is
 * `[{ host, summary }]` (busy runlocks), `agents` is `[{ host, doc }]`.
 */
export function deckQueues(queues, agents) {
  const docs = new Map(agents.map((a) => [a.host, a.doc]));
  const out = queues.map((q) => ({ host: q.host, summary: q.summary, agents: docs.get(q.host) ?? null }));
  for (const a of agents) if (agentsBusy(a.doc) && !out.some((q) => q.host === a.host)) out.push({ host: a.host, summary: null, agents: a.doc });
  return out;
}

/** The main board's face for one of those: the test queue's while it has runs, else the agents'. */
export const deckQueueKey = (entry) => (entry.summary ? queueKey(entry.summary) : agentsKey(entry.agents));
