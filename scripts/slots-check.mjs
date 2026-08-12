// Verifies project grouping: sessions for one VS Code window sit in one
// contiguous block, project order and within-project order are both pinned to
// first-seen, and nothing re-sorts by activity.
// Run: node scripts/slots-check.mjs
import { assignSlots, accentFor, attentionQueue, detailLayout, holdTiles } from "../src/index.mjs";

const s = (id, folder, nested = false) => ({ session_id: id, folder, nested });
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

import { matchFolder } from "../src/sessions.mjs";

// matchFolder: an exact match beats being nested under another open folder —
// a worktree opened as its own VS Code window is a real session, not nested.
eq(matchFolder("/proj/sub", ["/proj", "/proj/sub"]), { folder: "/proj/sub", nested: false }, "exact match wins");

// Among ancestor-only matches, the most specific (longest) folder wins —
// fixes the old .find()'s arbitrary first-match behavior.
eq(
  matchFolder("/proj/sub/deep", ["/proj", "/proj/sub"]),
  { folder: "/proj/sub", nested: true },
  "most specific ancestor wins"
);

// No open folder contains this cwd at all.
eq(matchFolder("/elsewhere", ["/proj"]), null, "no match");

// A trailing slash on cwd (never seen from Claude Code's own registry, but
// cheap to guard) must still resolve as an exact match, not fall through to
// a spurious "nested under itself" ancestor match.
eq(matchFolder("/proj/", ["/proj"]), { folder: "/proj", nested: false }, "trailing slash still matches exactly");

const A = "/projects/alpha";
const B = "/projects/beta";
const slots = new Array(5).fill(null);

assignSlots([s("a1", A), s("b1", B), s("a2", A)], slots);
eq(slots, ["a1", "a2", "b1", null, null], "groups by project, not arrival");

// Input order must not matter — only first-seen order does.
assignSlots([s("b1", B), s("a2", A), s("a1", A)], slots);
eq(slots, ["a1", "a2", "b1", null, null], "stable under reorder");

// A new session joins its own project's block rather than the board's end,
// pushing later projects along.
assignSlots([s("a1", A), s("a2", A), s("a3", A), s("b1", B)], slots);
eq(slots, ["a1", "a2", "a3", "b1", null], "new session joins its project block");

// A whole project going away closes its gap.
assignSlots([s("b1", B)], slots);
eq(slots, ["b1", null, null, null, null], "empty project leaves no gap");

// ...and returning reclaims its original position ahead of beta, because
// folder order is remembered.
assignSlots([s("b1", B), s("a9", A)], slots);
eq(slots, ["a9", "b1", null, null, null], "returning project keeps its place");

// Board full: extras simply get no button.
const small = new Array(2).fill(null);
assignSlots([s("a1", A), s("a2", A), s("b1", B)], small);
eq(small, ["a1", "a2"], "full board drops extras");

// A nested (worktree) session never claims its own slot, and attaches to
// the first (earliest-arrived) real session's button in its folder's block.
const nestedBySlot = new Array(5).fill(null);
assignSlots([s("a1", A), s("a2", A), s("w1", A, true), s("b1", B)], slots, nestedBySlot);
eq(slots, ["a1", "a2", "b1", null, null], "nested session claims no slot");
eq(nestedBySlot[0], [{ session_id: "w1", folder: A, nested: true }], "nested session attaches to the block's first button");
eq(nestedBySlot[1], null, "sibling real session in the same block gets no nested list");
eq(nestedBySlot[2], [], "unrelated project's primary button gets an empty (not null) nested list");

// A folder with no nested sessions at all: its primary button gets an empty
// list, not null — callers can treat "primary button" and "has a list" the
// same way without a null check.
const nestedBySlot2 = new Array(5).fill(null);
assignSlots([s("a1", A)], slots, nestedBySlot2);
eq(nestedBySlot2[0], [], "primary button with no nested sessions gets an empty list");

// Nested sessions keep first-seen order too, same as real sessions and
// folders do (CLAUDE.md: "ordering is first-seen, never activity") —
// independent of whatever order a given getLiveSessions() poll reports them
// in.
const nestedBySlot3 = new Array(5).fill(null);
assignSlots([s("a1", A), s("w1", A, true), s("w2", A, true)], slots, nestedBySlot3);
eq(nestedBySlot3[0].map((n) => n.session_id), ["w1", "w2"], "nested sessions ordered first-seen");
assignSlots([s("a1", A), s("w2", A, true), s("w1", A, true)], slots, nestedBySlot3);
eq(
  nestedBySlot3[0].map((n) => n.session_id),
  ["w1", "w2"],
  "nested session order survives being reported in a different order"
);

// A folder with only nested sessions and no real one at all (e.g. an
// interactive session that cd'd into a worktree) would otherwise vanish from
// the board entirely — the earliest-seen nested session is promoted to stand
// in as the primary instead.
const C = "/projects/gamma";
const nestedBySlot4 = new Array(5).fill(null);
assignSlots([s("w1", C, true)], slots, nestedBySlot4);
eq(slots, ["w1", null, null, null, null], "orphaned nested session is promoted to a real button");
eq(nestedBySlot4[0], [], "promoted session has no nested siblings of its own");

// Two orphaned nested sessions in the same folder: the earliest-seen one is
// promoted, the other still shows as its nested child.
const D = "/projects/delta";
const nestedBySlot5 = new Array(5).fill(null);
assignSlots([s("w1", D, true), s("w2", D, true)], slots, nestedBySlot5);
eq(slots, ["w1", null, null, null, null], "earliest nested session promoted when none is real");
eq(
  nestedBySlot5[0],
  [{ session_id: "w2", folder: D, nested: true }],
  "remaining nested session becomes the promoted button's child"
);

// Self-healing: once a genuine real session shows up for a previously
// orphaned folder, it takes over as primary and the promoted stand-in
// reverts to being an ordinary nested child.
const E = "/projects/epsilon";
const nestedBySlot6 = new Array(5).fill(null);
assignSlots([s("w1", E, true)], slots, nestedBySlot6);
eq(slots, ["w1", null, null, null, null], "orphaned nested session promoted (before a real session exists)");
assignSlots([s("e1", E), s("w1", E, true)], slots, nestedBySlot6);
eq(slots, ["e1", null, null, null, null], "real session takes over as primary once it appears");
eq(
  nestedBySlot6[0],
  [{ session_id: "w1", folder: E, nested: true }],
  "previously-promoted session reverts to an ordinary nested child"
);

// A real session that cd's into a worktree mid-task (EnterWorktree) keeps its
// own button instead of collapsing into an indicator — otherwise a busy key
// blanks out in the middle of the work it's reporting on.
const F = "/projects/zeta";
const nestedBySlot7 = new Array(5).fill(null);
assignSlots([s("f1", F), s("f2", F)], slots, nestedBySlot7);
eq(slots, ["f1", "f2", null, null, null], "two real sessions in one project");
assignSlots([s("f1", F, true), s("f2", F)], slots, nestedBySlot7);
eq(slots, ["f1", "f2", null, null, null], "settled session keeps its slot after entering a worktree");
eq(nestedBySlot7[0], [], "and does not become its own nested child");

// ...but a session first seen inside a worktree still is one, even when its
// folder already has a real session — that's the background-checkout case the
// indicator exists for.
assignSlots([s("f1", F), s("f2", F), s("w9", F, true)], slots, nestedBySlot7);
eq(slots, ["f1", "f2", null, null, null], "session first seen nested claims no slot");
eq(nestedBySlot7[0].map((n) => n.session_id), ["w9"], "session first seen nested stays an indicator");

// Accents come from what's free, not from position % 8. folderOrder is never
// pruned, so a long-lived folder plus enough churn used to hand a new project
// the colour of one still on the board: position 8 wrapped onto position 0.
// Colours are only guaranteed distinct up to ACCENTS.length live folders —
// past that something must repeat, and that isn't what this guards.
const acc = (i) => `/projects/acc${i}`;
const wide = new Array(9).fill(null);

// One folder stays live throughout; seven others appear alongside it...
assignSlots([s("acc0", acc(0))], wide);
const first = accentFor(acc(0));
assignSlots(Array.from({ length: 8 }, (_, i) => s(`acc${i}`, acc(i))), wide);
eq(new Set(Array.from({ length: 8 }, (_, i) => accentFor(acc(i)))).size, 8, "eight live folders get eight distinct accents");
eq(accentFor(acc(0)), first, "a folder keeps its colour as others appear");

// ...then go away, and a ninth folder arrives while the first is still shown.
assignSlots([s("acc0", acc(0)), s("acc8", acc(8))], wide);
eq(accentFor(acc(8)) !== first, true, "a new folder does not reuse a live folder's colour after the list wraps");
eq(accentFor(acc(0)), first, "and the long-lived folder still keeps its own");

// The attention queue is the one board that sorts by activity: blocked ahead
// of waiting, longest-stuck first inside each group. Nested sessions are
// included — they have no key of their own, so this is the only view that can
// give them a title.
const q = (id, state, ts, nested = false) => ({ session_id: id, folder: "/projects/q", state, ts, nested });
const ids = (list) => list.map((x) => x.session_id);

eq(
  ids(attentionQueue([q("a", "waiting", 100), q("b", "requires_action", 500)], 1000)),
  ["b", "a"],
  "requires_action outranks waiting regardless of age"
);
eq(
  ids(attentionQueue([q("new", "waiting", 900), q("old", "waiting", 100)], 1000)),
  ["old", "new"],
  "longest-stuck first inside a group"
);
eq(
  ids(attentionQueue([q("busy1", "busy", 100), q("idle1", "idle", 100), q("w", "waiting", 100)], 1000)),
  ["w"],
  "only blocked and waiting sessions appear"
);
eq(
  ids(attentionQueue([q("n", "waiting", 100, true), q("r", "waiting", 200)], 1000)),
  ["n", "r"],
  "nested sessions are included"
);
// Equal timestamps must not let two sessions swap places between polls.
eq(
  ids(attentionQueue([q("b", "waiting", 100), q("a", "waiting", 100)], 1000)),
  ["a", "b"],
  "ties broken stably"
);
eq(attentionQueue([], 1000).length, 0, "nothing waiting");
// ts: 0 means the registry carried no timestamp at all (sessions.mjs's
// fallback), not "began at the Unix epoch". The sort's `a.ts || nowSeconds`
// guard must treat it as "now", so it must not leapfrog a session with a
// real, older timestamp purely by looking like the oldest possible value.
eq(
  ids(attentionQueue([q("real", "waiting", 500), q("unknown", "waiting", 0)], 1000)),
  ["real", "unknown"],
  "ts: 0 does not sort ahead of a real timestamp as if it were the epoch"
);

// The detail board: five header tiles, then tasks, with worktree tiles held
// at the tail so a long task list can't push them off the board entirely.
const dSession = {
  session_id: "d1",
  folder: "/projects/kob-trace",
  state: "busy",
  context: 41,
  model: "claude-opus-5",
  effort: "high",
  aiTitle: "serializing client-block mutations",
};
const dTask = (subject, status = "pending") => ({ subject, status });

const plain = detailLayout({ session: dSession, tasks: [dTask("read the code"), dTask("lock it", "in_progress")], nested: [], age: "40m", slotCount: 13 });
eq(plain.length, 13, "layout always fills the board");
eq(plain.slice(0, 2).map((t) => t.kind), ["label", "label"], "title spans two tiles");
eq(plain[2], { kind: "stat", label: "STATE", value: "busy 40m" }, "state tile carries the age");
eq(plain[3], { kind: "stat", label: "CONTEXT", value: "41%" }, "context tile");
eq(plain[4], { kind: "stat", label: "MODEL", value: "opus-5 high" }, "model tile drops the vendor prefix");
eq(plain[5], { kind: "task", number: 1, subject: "read the code", status: "pending" }, "tasks start at slot 5");
eq(plain[6].status, "in_progress", "task status is carried through");
eq(plain[7], null, "unused slots are null");

// Worktree tiles hold the tail; tasks take what's left in front of them.
const withNested = detailLayout({
  session: dSession,
  tasks: Array.from({ length: 20 }, (_, i) => dTask(`Task ${i + 1}`, i === 0 ? "in_progress" : "pending")),
  nested: [{ session_id: "w1", state: "busy" }, { session_id: "w2", state: "idle" }],
  age: "40m",
  slotCount: 13,
});
eq(withNested.length, 13, "layout still fills the board");
eq(withNested.slice(11).map((t) => t.kind), ["nested", "nested"], "worktree tiles sit at the tail");
eq(withNested.slice(5, 11).every((t) => t.kind === "task"), true, "tasks fill the space in front of them");

// Task numbering is `tasks.indexOf(t) + 1` — absolute position in the full
// list — and holdTiles reads a held task tile back by `tasks[number - 1]`.
// The 20-task case above happens to put in_progress at index 0, so
// taskWindow's start is 0 too and absolute numbering (1..6) is
// indistinguishable from window-relative numbering (also 1..6) — it would
// not notice that pairing breaking. Put in_progress mid-list instead.
const midTasks = Array.from({ length: 20 }, (_, i) => dTask(`Task ${i + 1}`, i === 10 ? "in_progress" : "pending"));
const midNested = [{ session_id: "w1", state: "busy" }, { session_id: "w2", state: "idle" }];
const mid = detailLayout({ session: dSession, tasks: midTasks, nested: midNested, age: "40m", slotCount: 13 });
const midTaskTiles = mid.slice(5, 11);
eq(
  midTaskTiles.map((t) => t.number),
  [8, 9, 10, 11, 12, 13],
  "task numbering stays absolute (tasks.indexOf + 1), not reset to 1 at the window's start"
);
eq(
  midTaskTiles.find((t) => t.status === "in_progress").number,
  11,
  "the active task (array index 10) keeps its true number 11"
);
// And holdTiles must read the same task back by that same absolute number —
// the one arithmetic this whole export-for-testability exists to guard.
const midHeld = holdTiles(mid, mid, midTasks, midNested);
const midActiveSlot = midTaskTiles.findIndex((t) => t.status === "in_progress") + 5;
eq(
  midHeld[midActiveSlot],
  { kind: "task", number: 11, subject: "Task 11", status: "in_progress" },
  "holdTiles re-reads the active task by its absolute number, not its position in the window"
);

// After /clear the transcript still holds the pre-clear session name; the
// header must go blank rather than present it as this session's title.
const cleared = detailLayout({
  session: { ...dSession, aiTitle: null, name: "old summary", clearedEmpty: true, cwd: "/projects/kob-trace" },
  tasks: [],
  nested: [],
  age: "",
  slotCount: 13,
});
eq(cleared.slice(0, 2), [{ kind: "label", label: "" }, { kind: "label", label: "" }], "cleared session shows no title");

// A session with no context reported must not print "null%".
const noCtx = detailLayout({ session: { ...dSession, context: null }, tasks: [], nested: [], age: "", slotCount: 13 });
eq(noCtx[3], { kind: "stat", label: "CONTEXT", value: "—" }, "unknown context shows a dash");

// Holding the board's shape for a visit: content follows each tile, position
// doesn't move. The case that matters is a worktree session appearing while
// the board is up — detailLayout re-pins worktree tiles to the tail on every
// poll, so the one already on screen shifts a slot left, onto a slot that was
// empty when the board opened. Taking the fresh tile there would draw that one
// session on two keys and never show the new one at all.
const wt = (id) => ({ session_id: id, state: "busy", nested: true, folder: "/projects/kob-trace", cwd: `/wt/${id}` });
const openTasks = [dTask("one", "in_progress"), dTask("two")];
const opened = detailLayout({ session: dSession, tasks: openTasks, nested: [wt("w1")], age: "40m", slotCount: 13 });
const later = detailLayout({ session: dSession, tasks: openTasks, nested: [wt("w1"), wt("w2")], age: "40m", slotCount: 13 });
eq(opened[12].session.session_id, "w1", "one worktree session sits in the last slot");
eq([later[11].session.session_id, later[12].session.session_id], ["w1", "w2"], "a second one shifts it left");

const held = holdTiles(opened, later, openTasks, [wt("w1"), wt("w2")]);
eq(held.length, 13, "held layout still fills the board");
eq(
  held.filter((t) => t?.kind === "nested").map((t) => t.session.session_id),
  ["w1"],
  "a worktree session occupies at most one key"
);
eq(held[12].session.session_id, "w1", "and keeps the slot it opened in");
eq(held[11], null, "the slot it would have been aliased into stays blank");

// Content still follows: a task completing recolours its own tile in place.
const done = holdTiles(opened, opened, [dTask("one", "completed"), dTask("two", "in_progress")], [wt("w1")]);
eq(done[5], { kind: "task", number: 1, subject: "one", status: "completed" }, "task tile takes fresh content in its own slot");
eq(done[6].status, "in_progress", "and so does the next one");

// A task or worktree session that disappears leaves a blank rather than
// pulling everything after it up a slot.
const gone = holdTiles(opened, opened, [dTask("one", "in_progress")], []);
eq(gone[6], null, "a vanished task blanks its slot");
eq(gone[12], null, "a vanished worktree session blanks its slot");

console.log("OK: project grouping");
