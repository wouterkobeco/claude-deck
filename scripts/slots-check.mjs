// Verifies project grouping: sessions for one VS Code window sit in one
// contiguous block, project order and within-project order are both pinned to
// first-seen, and nothing re-sorts by activity.
// Run: node scripts/slots-check.mjs
import { assignSlots, accentFor, attentionQueue, detailLayout, holdTiles, mostUrgent, isRepeatPress, DETAIL_BACK_INDEX, folderKeyFor } from "../src/index.mjs";

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

// A folder whose only sessions are subagents shows nothing. They are agents
// some script spawned, not ones you talk to, and a key for one is exactly the
// phantom that used to appear for a security review nobody opened. Their whole
// visibility is the margin marker on a project that does have a session, and
// the detail board behind it.
const C = "/projects/gamma";
const nestedBySlot4 = new Array(5).fill(null);
assignSlots([s("w1", C, true)], slots, nestedBySlot4);
eq(slots, [null, null, null, null, null], "a folder with only subagents claims no key");

// A cli session in a worktree is a full agent, not a subagent: nested is
// decided by entrypoint (sdk-* = spawned by another session), never by where
// the cwd happens to sit. Most work here happens in worktrees, so demoting
// them hid the main event behind a 3×6px marker.
const F = "/projects/zeta";
const nestedBySlot7 = new Array(5).fill(null);
assignSlots([s("f1", F), s("f2", F)], slots, nestedBySlot7);
eq(slots, ["f1", "f2", null, null, null], "two sessions in one project each get a key");
eq(nestedBySlot7[0], [], "neither is the other's subagent");

// ...and a genuine subagent alongside them still folds onto the block's first
// key rather than taking one of its own.
assignSlots([s("f1", F), s("f2", F), s("w9", F, true)], slots, nestedBySlot7);
eq(slots, ["f1", "f2", null, null, null], "a subagent claims no slot");
eq(nestedBySlot7[0].map((n) => n.session_id), ["w9"], "it attaches to the block's first key");

// ...unless it names a parent, which an Agent-tool subagent always does. Then
// it goes on that session's key, not the block's first. Attaching by folder
// painted an idle key green for a sibling's agent — with three sessions open
// in one repo, the key that went busy was whichever the daemon happened to see
// first, which after a restart is readdir order and means nothing at all.
const nestedBySlot8 = new Array(5).fill(null);
assignSlots([s("f1", F), s("f2", F), { ...s("w8", F, true), parent: "f2" }], slots, nestedBySlot8);
eq(nestedBySlot8[0], [], "the block's first key stays clean when the agent isn't its own");
eq(nestedBySlot8[1].map((n) => n.session_id), ["w8"], "a subagent lands on its parent's key");

// Both kinds at once: the parented one on its parent, the parentless sdk
// session still on the block's first key. Neither rule eats the other.
const nestedBySlot9 = new Array(5).fill(null);
assignSlots([s("f1", F), s("f2", F), { ...s("w8", F, true), parent: "f2" }, s("sdk1", F, true)], slots, nestedBySlot9);
eq(nestedBySlot9[0].map((n) => n.session_id), ["sdk1"], "a parentless sdk session still folds onto the block");
eq(nestedBySlot9[1].map((n) => n.session_id), ["w8"], "and the parented one stays on its parent");

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

// The detail board takes over the whole deck — usage and attention keys
// included — so it carries its own way out: a back key on the bottom-left
// button, spliced in at a fixed index so it lands on the same physical key
// however the content above it happens to fill.
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
const DECK = 15;

const plain = detailLayout({ session: dSession, tasks: [dTask("read the code"), dTask("lock it", "in_progress")], nested: [], age: "40m", slotCount: DECK });
eq(plain.length, DECK, "layout fills every key on the deck");
eq(plain[DETAIL_BACK_INDEX], { kind: "back" }, "the back key sits on the bottom-left button");
eq(plain.slice(0, 2).map((t) => t.kind), ["label", "label"], "title spans two tiles");
eq(plain[2], { kind: "stat", label: "STATE", value: "busy 40m" }, "state tile carries the age");
eq(plain[3], { kind: "stat", label: "CONTEXT", value: "41%", pie: 41 }, "context tile");
eq(plain[4], { kind: "stat", label: "MODEL", value: "opus-5 high" }, "model tile drops the vendor prefix");
eq(plain[5], { kind: "task", number: 1, subject: "read the code", status: "pending" }, "tasks start after the header");
eq(plain[6].status, "in_progress", "task status is carried through");
eq(plain[7], null, "unused slots are null");

// Subagents pin to the tail — this board and a 3×6px margin marker are the
// only places they appear at all, where a task list past the window is merely
// truncated.
const wtS = (id) => ({ session_id: id, state: "busy", nested: true, folder: "/projects/kob-trace", cwd: `/wt/${id}` });
const withTail = detailLayout({
  session: dSession,
  tasks: [dTask("only task", "in_progress")],
  nested: [wtS("w1"), wtS("w2"), wtS("w3")],
  age: "40m",
  slotCount: DECK,
});
eq(withTail.length, DECK, "layout still fills the deck");
eq(
  withTail.slice(-3).map((t) => `${t.kind}:${t.session.session_id}`),
  ["nested:w1", "nested:w2", "nested:w3"],
  "subagents sit at the tail, in order"
);
eq(withTail[DETAIL_BACK_INDEX], { kind: "back" }, "the back key keeps its position with a full tail");

// A long task list is what the tail has to survive: it must not push the
// subagents off the board, since they have nowhere else to appear.
const manyTasks = Array.from({ length: 20 }, (_, i) => dTask(`Task ${i + 1}`, i === 10 ? "in_progress" : "pending"));
const midNested = [wtS("w1"), wtS("w2")];
const mid = detailLayout({ session: dSession, tasks: manyTasks, nested: midNested, age: "40m", slotCount: DECK });
eq(
  mid.filter((t) => t?.kind === "nested").map((t) => t.session.session_id),
  ["w1", "w2"],
  "twenty tasks do not crowd the subagents off the board"
);
eq(mid[DETAIL_BACK_INDEX], { kind: "back" }, "and the back key is still reachable");

// Task numbering is `tasks.indexOf(t) + 1` — absolute position in the full
// list — and holdTiles reads a held task tile back by `tasks[number - 1]`.
// An in_progress task at index 0 would make absolute and window-relative
// numbering identical, so this puts it mid-list where they diverge.
const midTaskTiles = mid.filter((t) => t?.kind === "task");
eq(
  midTaskTiles.map((t) => t.number),
  [8, 9, 10, 11, 12, 13, 14],
  "task numbering stays absolute (tasks.indexOf + 1), not reset to 1 at the window's start"
);
eq(
  midTaskTiles.find((t) => t.status === "in_progress").number,
  11,
  "the active task (array index 10) keeps its true number 11"
);
// And holdTiles must read the same task back by that same absolute number —
// the one arithmetic this whole export-for-testability exists to guard.
const midHeld = holdTiles(mid, mid, manyTasks, midNested);
const midActiveSlot = mid.findIndex((t) => t?.kind === "task" && t.status === "in_progress");
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
  slotCount: DECK,
});
eq(cleared.slice(0, 2), [{ kind: "label", label: "" }, { kind: "label", label: "" }], "cleared session shows no title");

// A session with no context reported must not print "null%".
const noCtx = detailLayout({ session: { ...dSession, context: null }, tasks: [], nested: [], age: "", slotCount: DECK });
eq(noCtx[3], { kind: "stat", label: "CONTEXT", value: "—", pie: null }, "unknown context shows a dash, not a ring");

// Holding the board's shape for a visit: content follows each tile, position
// doesn't move. The case that matters is a subagent appearing while the board
// is up — detailLayout re-pins tail tiles on every poll, so the one already on
// screen shifts a slot left, onto a slot that was empty when the board opened.
// Taking the fresh tile there would draw that one session on two keys and
// never show the new one at all.
const openTasks = [dTask("one", "in_progress"), dTask("two")];
const opened = detailLayout({ session: dSession, tasks: openTasks, nested: [wtS("w1")], age: "40m", slotCount: DECK });
const later = detailLayout({ session: dSession, tasks: openTasks, nested: [wtS("w1"), wtS("w2")], age: "40m", slotCount: DECK });
eq(opened.filter((t) => t?.kind === "nested").map((t) => t.session.session_id), ["w1"], "one subagent before");
eq(later.filter((t) => t?.kind === "nested").map((t) => t.session.session_id), ["w1", "w2"], "two after, re-pinned");

const held = holdTiles(opened, later, openTasks, [wtS("w1"), wtS("w2")]);
eq(held.length, DECK, "held layout still fills the deck");
eq(
  held.filter((t) => t?.kind === "nested").map((t) => t.session.session_id),
  ["w1"],
  "a subagent occupies at most one key"
);
eq(held[DETAIL_BACK_INDEX], { kind: "back" }, "and the back key survives the hold");

// A key's colour covers its whole block: a session working only through a
// worktree subsession must read as working, not sit grey behind a marker.
eq(mostUrgent(["idle", "busy"]), "busy", "a busy subsession turns an idle key green");
eq(mostUrgent(["busy", "requires_action"]), "requires_action", "requires_action outranks busy");
eq(mostUrgent(["waiting", "busy"]), "waiting", "waiting outranks busy");
eq(mostUrgent(["shell", "idle"]), "shell", "shell outranks idle");
eq(mostUrgent(["idle"]), "idle", "a key with no subsessions keeps its own state");
eq(mostUrgent(["busy", "idle"]), "busy", "order of the states must not matter");
// An unrecognised state must not outrank a real one just by being unknown.
eq(mostUrgent(["busy", "no-such-state"]), "busy", "unknown state loses to a known one");

// A second press anywhere in the same project means "tell me more": the
// project's keys are one block, so moving along it is the same gesture as
// pressing one key twice.
const p1 = { index: 0, session_id: "a", folder: "/repo", host: null };
const p2 = { index: 1, session_id: "b", folder: "/repo", host: null };
const other = { index: 2, session_id: "c", folder: "/elsewhere", host: null };
const empty = { index: 3, session_id: null, folder: null, host: null };
// Windows the extension is running in. `folders` is what ties a published
// window to a session; `activeSessionId` is the session whose terminal is
// actually in front, which is the fact the whole rule turns on.
const win = (folders, focused, activeSessionId) => ({ pid: 1, folders, focused, activeSessionId });
const onA = [win(["/repo"], true, "a")];

// No window state at all: nothing is running the extension, so the rule falls
// back to what it always did. This is the path every un-reloaded window takes,
// and it must stay exactly as it was.
eq(isRepeatPress(null, p1, []), false, "the first press of all focuses, never opens detail");
eq(isRepeatPress(p1, p1, []), true, "without the extension, the same key twice still opens detail");
eq(isRepeatPress(p1, p2, []), true, "without the extension, a sibling still counts as the second press");
eq(isRepeatPress(other, p1, []), false, "a key from another project breaks the chain");
eq(isRepeatPress(p1, empty, []), false, "an empty key has nothing to tell you about");
eq(isRepeatPress(empty, p1, []), false, "and pressing one breaks the chain rather than continuing it");

// With the extension running, the rule is "did this press change anything".
// A sibling press DOES change something — it switches to a different
// terminal — so it is a first press, not a second. This assertion is the exact
// inverse of the one above it, and deliberately so: matching on the folder was
// justified by every key in a project's block doing the identical thing, and
// terminal focus made that false.
eq(isRepeatPress(p1, p2, onA), false, "with the extension, a sibling switches terminals — a first press");
eq(isRepeatPress(p1, p1, onA), true, "the same session again, already in front and focused, opens detail");

// Both halves of "changed nothing" are required.
eq(isRepeatPress(p1, p1, [win(["/repo"], false, "a")]), false, "alt-tabbed away: the press raises the window instead");
eq(isRepeatPress(p1, p1, [win(["/repo"], true, "b")]), false, "another terminal was clicked by hand: switch back first");
eq(isRepeatPress(p1, p1, [win(["/repo"], true, null)]), false, "nothing revealed yet, so nothing to escalate from");

// A window that publishes state but doesn't hold this session's folder says
// nothing about it — that session's window has no extension, so folder rule.
eq(isRepeatPress(p1, p2, [win(["/elsewhere"], true, "a")]), true, "an unrelated window doesn't govern this project");

// Multi-root: the published folders are matched with matchFolder, so a session
// under an open folder resolves to that window rather than missing it.
eq(isRepeatPress(p1, p1, [win(["/", "/repo"], true, "a")]), true, "matchFolder picks the most specific published folder");

// TWO windows open on the same folder — live on this machine, per CLAUDE.md
// (11854.lock and 53173.lock both claim kob/kob-backend). Only the window that
// actually revealed the session can report it as active, so every candidate is
// asked rather than one being elected. Electing one with .find() would answer
// from whichever readdir happened to return first, and get it wrong half the
// time — permanently, for every session in that folder.
const twoWindows = [win(["/repo"], false, null), win(["/repo"], true, "a")];
eq(isRepeatPress(p1, p1, twoWindows), true, "the window that revealed it answers, whichever order they're read in");
eq(isRepeatPress(p1, p1, [...twoWindows].reverse()), true, "and read order must not change the answer");
eq(isRepeatPress(p1, p1, [win(["/repo"], false, null), win(["/repo"], false, "a")]), false,
   "still false when no matching window is both focused and showing it");

// Capability inference. A window matching the folder proves only that *some*
// session there is revealable, never this one: `claude` in iTerm on a project
// also open in VS Code gets a board key (sessions.mjs joins on folder, not
// terminal) and its window still publishes, but no terminal in it will ever
// match this session's pid chain — same for tmux or any reparented process.
// Trusting the window's mere presence would make `matching.some(...)` false
// forever, which is a regression from before this branch: those sessions'
// second press used to open detail. Without capability info a window that
// never reveals this session must, past a grace period, fall back to the
// folder rule instead of staying permanently stuck.
const pz = { index: 4, session_id: "z", folder: "/repo", host: null };
const onlyAEverRevealed = [win(["/repo"], true, "a")]; // matches the folder, never reports "z"
const T0 = 1_000_000;

eq(
  isRepeatPress(pz, pz, onlyAEverRevealed, { requestedAt: new Map([["z", T0]]), everActive: new Set(), now: T0 + 5000 }),
  true,
  "asked long ago, never once reported active: falls back to the folder rule instead of staying stuck forever"
);
eq(
  isRepeatPress(pz, pz, onlyAEverRevealed, { requestedAt: new Map([["z", T0]]), everActive: new Set(), now: T0 + 200 }),
  false,
  "same session inside the grace period: too soon to call it unrevealable, no fallback yet"
);
eq(
  isRepeatPress(pz, pz, [win(["/repo"], true, "z")], { requestedAt: new Map([["z", T0]]), everActive: new Set(["z"]), now: T0 + 5000 }),
  true,
  "seen active at least once: the verified rule governs from then on, however long ago it was asked"
);
eq(
  isRepeatPress(pz, pz, onlyAEverRevealed, { requestedAt: new Map([["z", T0]]), everActive: new Set(["z"]), now: T0 + 5000 }),
  false,
  "seen active before but not right now (alt-tabbed away): the verified rule still says no rather than the fallback overriding it"
);

// Two hosts can hold the same path. Before folder keys were host-qualified,
// these two sessions shared one block and one accent — a merge nothing on the
// deck would explain.
const twoHosts = [
  { session_id: "a", folder: "/home/pi/x", host: "192.168.2.6", state: "idle", nested: false },
  { session_id: "b", folder: "/home/pi/x", host: "192.168.2.70", state: "idle", nested: false },
];
const twoSlots = new Array(13).fill(null);
assignSlots(twoHosts, twoSlots);
eq(twoSlots[0], "a", "the first host's session takes the first slot");
eq(twoSlots[1], "b", "the second host's session takes its own slot");
eq(
  accentFor(folderKeyFor(twoHosts[0])) !== accentFor(folderKeyFor(twoHosts[1])),
  true,
  "same path on two hosts gets two accents"
);

// And a local session is not merged with a remote one at the same path.
eq(folderKeyFor({ folder: "/x", host: null }), "/x", "a local key is the bare folder, as before");
eq(folderKeyFor({ folder: "/x", host: "h" }), "h:/x", "a remote key is qualified by its host");

// isRepeatPress must not let a window on one host answer for a session on
// another. Both fall back to the folder rule when no window publishes, and that
// rule compares paths — which two hosts can share.
const localPress = { index: 0, session_id: "a", folder: "/home/pi/x", host: null };
const remotePress = { index: 1, session_id: "b", folder: "/home/pi/x", host: "192.168.2.6" };
eq(isRepeatPress(remotePress, localPress, []), false, "a remote press does not make a local press at the same path a repeat");
eq(isRepeatPress(localPress, localPress, []), true, "the same local session at the same path still repeats");

// A published window on the wrong host must not satisfy the reveal test.
const remoteWindow = { pid: 1, folders: ["/home/pi/x"], focused: true, activeSessionId: "a", host: "192.168.2.6" };
eq(
  isRepeatPress({ ...localPress }, localPress, [remoteWindow]),
  true,
  "a window on another host is ignored, so the local folder rule still answers"
);

console.log("OK: project grouping");
