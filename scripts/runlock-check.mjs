// Verifies the remote test-queue key: parsing `runlock status --json` (text
// another machine wrote), the busy/idle fold that makes the key appear only
// while the box works, the key's face, and the board's tiles.
// Run: node scripts/runlock-check.mjs
import { parseRunlockStatus, queueSummary, queueKey, queueTiles, runsBySession, STUCK_AFTER_S } from "../src/runlock.mjs";
import { renderQueue } from "../src/render.mjs";

const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const holder = (requestor, cores, running_s) => ({ run_id: "r", requestor, label: `${requestor} run`, cores, pid: 1, running_s });
const waiter = (seq, requestor, cores, waiting_s) => ({ seq, run_id: "w", requestor, label: `${requestor} run`, cores, waiting_s });
const doc = (lanes) => JSON.stringify({ schema: 1, host: "BEAST", lanes });
const lane = (free, holders = [], waiters = [], name = "default") => ({ lane: name, capacity: 16, free, holders, waiters });

// --- parsing -----------------------------------------------------------------
// kills: trusting anything that parses, or a runlock with a different schema
eq(parseRunlockStatus("not json"), null, "garbage");
eq(parseRunlockStatus(JSON.stringify({ schema: 2, lanes: [] })), null, "unknown schema");
eq(parseRunlockStatus(JSON.stringify({ schema: 1 })), null, "no lanes");
// kills: a control character or a huge label reaching the SVG as-is
const odd = parseRunlockStatus(doc([lane(8, [{ requestor: "a\u001b[31mb", label: "x".repeat(500), cores: 8, running_s: 3 }])]));
eq(odd.lanes[0].holders[0].requestor, "a [31mb", "control characters blanked");
eq(odd.lanes[0].holders[0].label.length, 80, "label bounded");
// kills: a negative or non-number age/width passed through as a number
const bad = parseRunlockStatus(doc([lane(8, [{ requestor: "a", cores: "8", running_s: -5 }])]));
eq([bad.lanes[0].holders[0].cores, bad.lanes[0].holders[0].age], [null, null], "bad numbers read as unknown");

// --- idle vs busy: the key exists only while the box works ----------------------
// kills: a key for an idle box, which is fourteen keys' worth of noise at rest
eq(queueSummary(parseRunlockStatus(doc([lane(16)]))), null, "idle box: no key");
eq(queueSummary(null), null, "no answer: no key");
// kills: counting only the default lane's runs (kob-portal2 once queued on its own lane)
const pooled = queueSummary(parseRunlockStatus(doc([lane(8, [], [waiter(3, "me", 2, 30)]), lane(16, [holder("ci:kob-trace", 8, 60)], [], "portal")])));
eq([pooled.holders.length, pooled.waiters.length, pooled.capacity, pooled.free], [1, 1, 16, 8], "runs pooled across lanes, budget from default");

// --- the key's face ----------------------------------------------------------
// kills: showing a count instead of the budget while nothing waits
const running = queueKey(queueSummary(parseRunlockStatus(doc([lane(4, [holder("ci:kob-backend", 8, 90), holder("repo:kob-trace", 4, 10)])]))));
eq(running, { tone: "running", title: "BEAST", big: "12/16", line: "2 RUNNING", pct: 75 }, "running: cores used of the budget");
// kills: leaving the key green with runs waiting; the head's wait taken from the last waiter
const queued = queueKey(queueSummary(parseRunlockStatus(doc([lane(0, [holder("ci:kob-trace", 16, 200)], [waiter(5, "a", 16, 250), waiter(6, "b", 2, 20)])]))));
eq(queued, { tone: "queued", title: "BEAST", big: "2", line: "QUEUED 4m", pct: 100 }, "queued: count and head wait");
// kills: never turning red, or turning red a second early
const at = (s) => queueKey(queueSummary(parseRunlockStatus(doc([lane(0, [holder("x", 16, 1)], [waiter(1, "a", 16, s)])])))).tone;
eq([at(STUCK_AFTER_S - 1), at(STUCK_AFTER_S)], ["queued", "stuck"], "stuck from STUCK_AFTER_S");

// --- the board ---------------------------------------------------------------
// kills: waiters before holders, or losing the queue's order
const tiles = queueTiles(queueSummary(parseRunlockStatus(doc([lane(0, [holder("ci:kob-trace", 16, 200)], [waiter(5, "a", 16, 250), waiter(6, "b", 2, 20)])]))));
eq(tiles.map((t) => [t.tone, t.title, t.big, t.age]), [["running", "kob-trace", "16c", "3m"], ["queued", "a", "16c", "4m"], ["queued", "b", "2c", "20s"]], "holders first, then the queue in order");
// kills: hiding an elastic request's floor, or printing "8-8c" for a fixed one
const ranged = queueTiles(queueSummary(parseRunlockStatus(doc([lane(0, [{ ...holder("a", 8, 1), cores_min: 8 }], [{ ...waiter(1, "b", 16, 1), cores_min: 4 }])]))));
eq(ranged.map((t) => t.big), ["8c", "4-16c"], "min-max cores when the request is a range");
// kills: dropping the requestor's kind when the name moves to the title
eq(tiles[0].line, "ci · ci:kob-trace run", "the kind leads the small line");

// --- a session's own run: the pill on its key ------------------------------------
const sid = (n) => `0b51fb79-4ecd-4627-9fa8-798ff8b09ad${n}`;
const withSessions = parseRunlockStatus(doc([lane(0,
  [{ ...holder("ci:x", 16, 200), session: sid(1) }],
  [{ ...waiter(5, "a", 2, 250), session: sid(2) }, { ...waiter(6, "b", 2, 20), session: "bad; id" }])]));
// kills: trusting a session id that is not one (it becomes a Map key and a lookup)
eq(withSessions.lanes[0].waiters[1].session, null, "a malformed session id is dropped");
const runs = runsBySession([{ summary: queueSummary(withSessions) }]);
// kills: no pill for a holding session, or the wrong face for either state
eq([...runs], [[sid(1), { kind: "running", text: "RUN 3m" }], [sid(2), { kind: "queued", text: "Q1 4m" }]], "running and queued pills, the head of the queue being Q1");
// kills: a later holder hiding the wait, which is the one worth knowing about
const both = runsBySession([{ summary: queueSummary(parseRunlockStatus(doc([lane(0,
  [{ ...holder("ci:x", 8, 200), session: sid(3) }], [{ ...waiter(7, "c", 8, 90), session: sid(3) }])]))) }]);
eq(both.get(sid(3)), { kind: "queued", text: "Q1 1m" }, "a session waiting and holding shows the wait");
// kills: every waiter reading Q1, or counting from zero
const third = runsBySession([{ summary: queueSummary(parseRunlockStatus(doc([lane(0, [], [waiter(8, "d", 2, 60), { ...waiter(9, "e", 2, 30), session: sid(4) }])]))) }]);
eq(third.get(sid(4)), { kind: "queued", text: "Q2 30s" }, "the second in line reads Q2");

// --- it draws ----------------------------------------------------------------
const buf = await renderQueue({ width: 72, height: 72, ...queued });
eq(buf.length, 72 * 72 * 4, "renders a key");
const tileBuf = await renderQueue({ width: 72, height: 72, ...tiles[2] });
eq(tileBuf.length, 72 * 72 * 4, "renders a tile");

console.log("OK: runlock queue key");
