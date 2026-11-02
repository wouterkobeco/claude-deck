// Verifies the agent queue: parsing kob-dispatch's `status --json` (text
// another machine wrote), the key's face, and the queue page's Agents section.
// Run: node scripts/dispatch-check.mjs
import { parseDispatchStatus, agentsKey, deckQueues, deckQueueKey } from "../src/dispatch.mjs";
import { parseRunlockStatus, queueSummary } from "../src/runlock.mjs";
import { queuePage } from "../src/queue-page.mjs";
import { renderQueue } from "../src/render.mjs";

const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const lease = (n, kind, o = {}) => ({ n, kind, host: "beast", attempt: 0, startedAt: 1000, title: `issue ${n}`, areas: ["area:blocks"], migration: false, ...o });
const doc = (o = {}) => JSON.stringify({ capacity: 2, leases: [], waiting: [], cards: [], hold: null, orphans: [], lastTickAgeSeconds: 12, ...o });

// --- parsing -----------------------------------------------------------------
// kills: trusting anything that parses
eq(parseDispatchStatus("not json"), null, "garbage");
eq(parseDispatchStatus(""), null, "empty answer");
eq(parseDispatchStatus("null"), null, "null");
eq(parseDispatchStatus(JSON.stringify({ capacity: 2 })), null, "no leases array");
// kills: a missing field crashing or passing through as undefined
const bare = parseDispatchStatus(JSON.stringify({ leases: [] }));
eq(bare, { capacity: null, leases: [], waiting: [], cards: [], hold: null, lastTickAgeSeconds: null }, "missing fields read as empty");
// kills: a huge title or a control character reaching the key or page as-is
const odd = parseDispatchStatus(doc({ leases: [lease(5, "worker", { title: "a\u001b[31mb" + "x".repeat(5000), areas: Array(100).fill("y".repeat(500)) })] }));
eq([odd.leases[0].title.slice(0, 6), odd.leases[0].title.length, odd.leases[0].areas.length, odd.leases[0].areas[0].length], ["a [31m", 120, 6, 30], "strings bounded, control chars blanked");
// kills: an issue number that is not a plain positive integer reaching a URL
const nums = parseDispatchStatus(doc({ leases: [lease("5/../x", "worker"), lease(-1, "worker"), lease(1.5, "worker"), lease(7, "rm -rf")], cards: [{ n: "9", title: "t" }, { n: 9, title: 4 }] }));
eq(nums.leases.map((l) => [l.n, l.kind]), [[7, "agent"]], "bad issue numbers dropped, unknown kind neutral");
eq(nums.cards, [{ n: 9, title: "" }], "a non-string title reads empty");
// kills: an unbounded list
eq(parseDispatchStatus(doc({ waiting: Array.from({ length: 500 }, (_, i) => ({ n: i + 1, reason: "r", title: "t" })) })).waiting.length, 50, "lists bounded");
// kills: a hold with no reason read as no hold
eq(parseDispatchStatus(doc({ hold: { reason: 42 } })).hold, { reason: "" }, "a hold without a reason is still a hold");

// --- the key's face ----------------------------------------------------------
// kills: an idle dispatcher drawn busy
eq(agentsKey(parseDispatchStatus(doc())), { tone: "idle", title: "AGENTS", big: "0/2", line: "0 queued", pct: 0 }, "idle");
// kills: the busy count or the queue missing, cards not mentioned
const busy = agentsKey(parseDispatchStatus(doc({ leases: [lease(1, "worker")], waiting: [{ n: 3, reason: "area busy", title: "t" }], cards: [{ n: 4, title: "c" }] })));
eq(busy, { tone: "running", title: "AGENTS", big: "1/2", line: "1 queued · 1 card", pct: 50 }, "busy");
// kills: a held dispatcher not turning red
const held = agentsKey(parseDispatchStatus(doc({ leases: [lease(1, "worker")], hold: { reason: "owner said stop" } })));
eq([held.tone, held.line], ["stuck", "HELD"], "held");
// it draws
eq((await renderQueue({ width: 72, height: 72, ...busy })).length, 72 * 72 * 4, "renders a key");

// --- the main board's queue keys: one per host, either queue busy ----------------
const runlockBusy = queueSummary(parseRunlockStatus(JSON.stringify({ schema: 1, host: "BEAST", lanes: [{ lane: "default", capacity: 16, free: 8, holders: [{ requestor: "ci:x", cores: 8, running_s: 60 }], waiters: [] }] })));
const agentsBusyDoc = parseDispatchStatus(doc({ leases: [lease(1, "worker")] }));
const agentsIdleDoc = parseDispatchStatus(doc());
const hosts = (q, a) => deckQueues(q, a).map((e) => [e.host, !!e.summary, !!e.agents]);
// kills: an agents-only host left off the board (the key existing only while tests run)
eq(hosts([], [{ host: "beast", doc: agentsBusyDoc }]), [["beast", false, true]], "idle runlock + busy agents: one key");
// kills: a host busy on both getting two keys
eq(hosts([{ host: "beast", summary: runlockBusy }], [{ host: "beast", doc: agentsBusyDoc }]), [["beast", true, true]], "both busy: one key");
// kills: an idle dispatcher taking a key
eq(hosts([], [{ host: "beast", doc: agentsIdleDoc }]), [], "neither busy: no key");
eq(hosts([], []), [], "nothing answered: no key");
// kills: a hold not earning a key
eq(hosts([], [{ host: "beast", doc: parseDispatchStatus(doc({ hold: { reason: "r" } })) }]).length, 1, "a held dispatcher earns a key");
// kills: the test queue's face replaced by the agents' while tests run, or an empty test face for agents only
eq(deckQueueKey(deckQueues([{ host: "beast", summary: runlockBusy }], [{ host: "beast", doc: agentsBusyDoc }])[0]).line, "1 RUNNING", "both busy: the test queue's face");
eq(deckQueueKey(deckQueues([], [{ host: "beast", doc: agentsBusyDoc }])[0]).title, "AGENTS", "agents only: the agents' face");

// --- the queue page ----------------------------------------------------------
const now = 1000 * 1000 + 125 * 1000; // two minutes after startedAt
const page = (agents) => queuePage("tok", [], now, agents);
// kills: no Agents section, or one shown for a host without a dispatcher
eq(page([]).includes("Agents"), false, "no dispatcher: nothing about agents");
const evil = parseDispatchStatus(doc({
  leases: [lease(12, "planner", { title: "<script>alert(1)</script>", attempt: 1 })],
  waiting: [{ n: 13, reason: "<b>area</b>", title: "w" }],
  cards: [{ n: 14, title: `"><img src=x>` }],
  hold: { reason: "<i>stop</i>" },
}));
const html = page([{ host: "<BEAST>", doc: evil }]);
// kills: an unescaped title, reason or host
eq(["<script>", "<b>area", "<img", "<i>stop", "<BEAST>"].map((s) => html.includes(s)), [false, false, false, false, false], "everything escaped");
eq(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true, "title shown escaped");
// kills: a lease without its link, kind, attempt or running time; waiting/card rows missing
for (const want of ['href="https://github.com/wouterkobeco/kob-trace/issues/12"', ">planner<", "retry 1", ">2m<", "issues/13", "issues/14", "cards waiting", "held"]) {
  eq(html.includes(want), true, `page shows ${want}`);
}
// kills: the page failing with agents but no test queue, or the reverse
eq(page([{ host: "beast", doc: parseDispatchStatus(doc()) }]).includes("No test run is queued"), true, "agents alone still render the empty test queue line");
eq(queuePage("tok", [{ host: "beast", budget: [], tiles: [], ended: [] }], now).includes("Agents"), false, "test queue alone: no agents");

console.log("OK: dispatch agent queue");

// --- what an agent is doing -----------------------------------------------------
import { parseActivity } from "../src/dispatch.mjs";
const asst = (...c) => JSON.stringify({ type: "assistant", message: { content: c } });
const tail = [
  '{"type":"user","message":{"cont', // cut mid-line
  asst({ type: "tool_use", name: "Edit", input: { file_path: "/home/x/repo/src/data/a.ts" } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
].join("\n");
// kills: reading the tool result or the cut line instead of the last call; an absolute path in full
eq(parseActivity(tail), "Edit src/data/a.ts", "last tool call");
eq(parseActivity(asst({ type: "tool_use", name: "Bash", input: { command: "pnpm test\nmore" } })), "Bash : pnpm test", "bash shows the command's first line");
eq(parseActivity(asst({ type: "text", text: "Looking at the schema" })), "Looking at the schema", "falls back to text");
eq(parseActivity("garbage"), "", "unreadable reads empty");
