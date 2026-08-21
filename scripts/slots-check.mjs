// Verifies project grouping: sessions for one VS Code window sit in one
// contiguous block, project order and within-project order are both pinned to
// first-seen, and nothing re-sorts by activity.
// Run: node scripts/slots-check.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignSlots, accentFor, boardTiles, statusKey, loadAccents, attentionQueue, freeQueue, busyQueue, detailLayout, holdTiles, mostUrgent, isRepeatPress, DETAIL_BACK_INDEX, folderKeyFor, ACCENTS } from "../src/index.mjs";
import { readProjects, writeProjects, applyAccentChoice, moveProject } from "../src/accents.mjs";

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

// Remembered accents. loadAccents() is what run() calls at startup with
// whatever readAccents() found; from assignSlots' point of view a remembered
// folder is indistinguishable from one it assigned itself, which is the whole
// point — it keeps its colour without ever having been on this board.
const rem = (i) => `/projects/rem${i}`;
loadAccents([[rem(0), ACCENTS[3]]]);
assignSlots([s("rem0", rem(0))], wide);
eq(accentFor(rem(0)), ACCENTS[3], "a remembered folder keeps its colour");

// Two folders can remember the same colour: they were never live at the same
// time, so neither claim ever saw the other. The day they are both on the
// board, one has to yield or the accent stops telling the two apart — the one
// processed first keeps it, like every other first-seen rule here.
loadAccents([[rem(1), ACCENTS[5]], [rem(2), ACCENTS[5]]]);
assignSlots([s("rem1", rem(1)), s("rem2", rem(2))], wide);
eq(accentFor(rem(1)), ACCENTS[5], "the first of two colliding folders keeps the remembered colour");
eq(accentFor(rem(2)) !== ACCENTS[5], true, "and the second re-claims a free one");

// The eviction is not a one-poll repair that flips back on the next poll: the
// re-claim is written into the map, so the loser stays put.
const settled = accentFor(rem(2));
assignSlots([s("rem1", rem(1)), s("rem2", rem(2))], wide);
eq(accentFor(rem(2)), settled, "and the loser's new colour sticks across polls");

// The collision rule is about folders, but the loop is over sessions: a
// project's second session used to see its own colour already claimed, evict
// it and re-take the lowest free accent every poll — so a manual pick from the
// config page vanished for any project with two sessions open, which is most
// of them.
loadAccents([[rem(3), ACCENTS[5]]]);
assignSlots([s("rem3a", rem(3)), s("rem3b", rem(3))], wide);
eq(accentFor(rem(3)), ACCENTS[5], "a project with two sessions keeps its colour");

// Round-trip through a real file, since every failure path in accents.mjs
// swallows its error — a write that silently does nothing would look exactly
// like a first run, forever.
const accentDir = mkdtempSync(join(tmpdir(), "streamdeck-accents-"));
const roundAccents = new Map([["/projects/x", "#4fc3f7"], ["pi:/home/pi/x", "#ff8a65"]]);
writeProjects(roundAccents, ["pi:/home/pi/x", "/projects/x"], accentDir);
eq([...readProjects(accentDir).accents], [...roundAccents], "accents round-trip");
eq(readProjects(accentDir).order, ["pi:/home/pi/x", "/projects/x"], "and so does the order, not the write order");
eq([...readProjects(join(accentDir, "nope")).accents], [], "a missing file reads as nothing remembered");
eq(readProjects(join(accentDir, "nope")).order, [], "and no order either");

// The shape this file had before the config page could reorder. A plain string
// value must still be read as that project's colour: the alternative is
// silently dropping every colour already on disk the day this shipped.
writeFileSync(join(accentDir, "streamdeck-accents.json"), '{"/projects/old":"#4db6ac"}');
eq([...readProjects(accentDir).accents], [["/projects/old", "#4db6ac"]], "the old string-valued file still reads its colours");
eq(readProjects(accentDir).order, [], "and reports no remembered order");

// Positions are sorted, not trusted: they are only ever this module's own array
// indices, but a hand-edited file can hold gaps or write them out of sequence.
writeFileSync(
  join(accentDir, "streamdeck-accents.json"),
  '{"/a":{"accent":"#4fc3f7","order":9},"/b":{"accent":"#ff8a65","order":2}}'
);
eq(readProjects(accentDir).order, ["/b", "/a"], "order comes from the numbers, not the file's key order");
rmSync(accentDir, { recursive: true, force: true });

// Reordering. The splice removes before it locates the target, so dragging a
// row downward past itself lands where you dropped it rather than one short —
// which is the whole reason this is a function with a check rather than two
// lines inline.
const order = ["a", "b", "c", "d"];
moveProject(order, "d", "b");
eq(order, ["a", "d", "b", "c"], "moving up inserts before the target");
moveProject(order, "a", "c");
eq(order, ["d", "b", "a", "c"], "moving down past itself lands on the target, not after it");
moveProject(order, "d", null);
eq(order, ["b", "a", "c", "d"], "a null target means last");
moveProject(order, "nope", "b");
eq(order, ["b", "a", "c", "d"], "an unknown key changes nothing");
moveProject(order, "b", "gone");
eq(order, ["a", "c", "d", "b"], "an unknown target means last, not a lost project");

// The swap the config UI performs, kept pure and kept in accents.mjs rather
// than beside persistAccents: that writes the real ~/.claude file with no root
// argument, so an exported mutator that persisted would clobber this machine's
// accents with fixture folders every time the checks run.
const P = "/projects/pick";
const Q = "/projects/quill";
const R = "/projects/closed";

// Both live, Q holds what P wants: they trade, so no colour is ever duplicated
// among live folders and assignSlots' collision rule has nothing to resolve.
const swapped = new Map([[P, ACCENTS[0]], [Q, ACCENTS[1]]]);
applyAccentChoice(swapped, new Set([P, Q]), P, ACCENTS[1]);
eq([...swapped], [[P, ACCENTS[1]], [Q, ACCENTS[0]]], "a swap trades both ways");

// Nobody holds it: nobody else changes.
const free = new Map([[P, ACCENTS[0]], [Q, ACCENTS[1]]]);
applyAccentChoice(free, new Set([P, Q]), P, ACCENTS[4]);
eq([...free], [[P, ACCENTS[4]], [Q, ACCENTS[1]]], "picking a free colour changes nobody else");

// A remembered-but-closed folder holds it. Trading with something that isn't
// on the board would be invisible, and leaving the duplicate in the file means
// the collision rule picks a winner by readdir order when it reopens — half
// the time taking back a colour you deliberately assigned. Drop its entry: it
// re-claims like any new arrival.
const closed = new Map([[P, ACCENTS[0]], [R, ACCENTS[2]]]);
applyAccentChoice(closed, new Set([P]), P, ACCENTS[2]);
eq([...closed], [[P, ACCENTS[2]]], "a closed owner's entry is dropped, not duplicated");

// ...and the pick then survives that folder coming back: with no duplicate in
// the map, assignSlots claims a free colour for the returning folder and
// leaves the hand-picked one alone.
loadAccents([...closed]);
assignSlots([s("pick", P), s("back", R)], wide);
eq(accentFor(P), ACCENTS[2], "a manual pick survives the closed folder reopening");
eq(accentFor(R) !== ACCENTS[2], true, "and the returning folder takes something else");

// The attention queue is the one board that sorts by activity: blocked ahead
// of waiting, longest-stuck first inside each group. Nested sessions are
// included — they have no key of their own, so this is the only view that can
// give them a title.
const q = (id, state, ts, nested = false, extra = {}) => ({ session_id: id, folder: "/projects/q", state, ts, nested, ...extra });
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

// --- the free queue --------------------------------------------------------

// The mirror: attentionQueue answers "who needs me", freeQueue answers "where
// can I put the next thing". Longest-idle first, because a session that
// finished twenty minutes ago is more obviously spare than one that stopped
// ten seconds ago and may be mid-thought.
eq(ids(freeQueue([q("new", "idle", 900), q("old", "idle", 100)], 1000)), ["old", "new"], "longest idle first");
eq(
  ids(freeQueue([q("b", "busy", 100), q("w", "waiting", 100), q("i", "idle", 100), q("s", "shell", 100)], 1000)),
  ["i"],
  "only idle is free — a background shell it started is still running"
);
eq(ids(freeQueue([q("b", "idle", 100), q("a", "idle", 100)], 1000)), ["a", "b"], "ties broken stably");
eq(freeQueue([], 1000).length, 0, "nothing free");

// The one that makes this queue agree with the board it sits beside. `refresh`
// colours a key mostUrgent([own, ...nested]), so a session whose Agent-tool
// subagent is still running reads busy on the deck; offering it here as free
// would contradict the key two rows up. The fold has to happen in both places.
{
  const parent = q("p", "idle", 100);
  const agent = q("a1", "busy", 100, true, { parent: "p" });
  eq(ids(freeQueue([parent, agent], 1000)), [], "a session whose subagent is working is not free");
  const done = q("a2", "idle", 100, true, { parent: "p" });
  eq(ids(freeQueue([parent, done], 1000)), ["p"], "and is free again once it finishes");
}
// A subagent is never itself an answer to "where can I put work": it has no
// window of its own and nobody opened it.
eq(ids(freeQueue([q("n", "idle", 100, true, { parent: "x" })], 1000)), [], "nested sessions are not offered as capacity");

// --- the busy queue ----------------------------------------------------

// The status key's third leg: same fold as freeQueue, same longest-first
// instinct run the other way — the one that's been at it longest is the one
// most likely to have been forgotten about.
eq(ids(busyQueue([q("new", "busy", 900), q("old", "busy", 100)], 1000)), ["old", "new"], "longest busy first");
eq(
  ids(busyQueue([q("b", "busy", 100), q("w", "waiting", 100), q("i", "idle", 100), q("s", "shell", 100)], 1000)),
  ["b"],
  "only busy is busy — waiting, idle and shell are all something else"
);
eq(busyQueue([], 1000).length, 0, "nothing busy");
{
  const parent = q("p", "idle", 100);
  const agent = q("a1", "busy", 100, true, { parent: "p" });
  eq(ids(busyQueue([parent, agent], 1000)), ["p"], "a subagent still running reads busy on its parent's own key");
}
eq(ids(busyQueue([q("n", "busy", 100, true, { parent: "x" })], 1000)), [], "nested sessions are not offered here either");
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
  cwd: "/projects/kob-trace",
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
eq(plain[0], { kind: "label", label: "serializing client-block mutations", project: "kob-trace" }, "the title is one key, the session's own");
eq(plain[1], { kind: "stat", label: "STATE", value: "busy 40m" }, "state tile carries the age");
eq(plain[2], { kind: "stat", label: "CONTEXT", value: "41%", pie: 41 }, "context tile");
eq(plain[3], { kind: "stat", label: "MODEL", value: "opus-5 high" }, "model tile drops the vendor prefix");
eq(plain[4], { kind: "task", number: 1, subject: "read the code", status: "pending" }, "tasks start after the header");
eq(plain[5].status, "in_progress", "task status is carried through");
eq(plain[6], null, "unused slots are null");

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
  [7, 8, 9, 10, 11, 12, 13, 14],
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
eq(cleared[0], { kind: "label", label: "", project: "kob-trace" }, "cleared session shows no title");

// Before Claude Code has generated an aiTitle — the first turn or two of every
// session — the body is the last thing typed. The two rungs under it are a name
// derived from the cwd (`kob-trace-01`) and the cwd itself, both of which say
// less than the caps bar above them, so they're where the chain ends rather
// than what it usually reaches. What it must never do is come out blank: a
// working session reading CLEAR is the bug this rung fixed.
const untitled = { ...dSession, aiTitle: null, name: "kob-trace-01", cwd: "/projects/kob-trace" };
const layout = (session) => detailLayout({ session, tasks: [], nested: [], age: "", slotCount: DECK })[0];
eq(
  layout({ ...untitled, lastPrompt: "process the backend change queue" }),
  { kind: "label", label: "process the backend change queue", project: "kob-trace" },
  "an untitled session reads as what you asked it"
);
eq(
  layout({ ...untitled, aiTitle: "Drain the change queue", lastPrompt: "process the backend change queue" }),
  { kind: "label", label: "Drain the change queue", project: "kob-trace" },
  "and hands over to the title once one exists"
);
eq(
  layout(untitled),
  { kind: "label", label: "kob-trace-01", project: "kob-trace" },
  "with no prompt found at all it still says something, never CLEAR"
);

// A session with no context reported must not print "null%".
const noCtx = detailLayout({ session: { ...dSession, context: null }, tasks: [], nested: [], age: "", slotCount: DECK });
eq(noCtx[2], { kind: "stat", label: "CONTEXT", value: "—", pie: null }, "unknown context shows a dash, not a ring");

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

// nestedFor's fallback branch (an SDK-entrypoint nested session, which never
// carries a `parent`) used to match on folder alone — the same host-merge bug
// one level down. Two hosts at the same path, each with its own primary
// session and its own parentless SDK nested session: each host's subagent
// must attach only to that host's key, not bleed onto the other host's.
const twoHostsWithSdk = [
  { session_id: "pA", folder: "/home/pi/x", host: "192.168.2.6", nested: false },
  { session_id: "pB", folder: "/home/pi/x", host: "192.168.2.70", nested: false },
  { session_id: "sdkA", folder: "/home/pi/x", host: "192.168.2.6", nested: true },
  { session_id: "sdkB", folder: "/home/pi/x", host: "192.168.2.70", nested: true },
];
const twoHostSlots = new Array(13).fill(null);
const twoHostNested = [];
assignSlots(twoHostsWithSdk, twoHostSlots, twoHostNested);
eq(twoHostSlots[0], "pA", "host A's session takes the first slot");
eq(twoHostSlots[1], "pB", "host B's session takes its own slot");
eq(
  twoHostNested[0].map((n) => n.session_id),
  ["sdkA"],
  "host A's SDK nested session attaches only to host A's key"
);
eq(
  twoHostNested[1].map((n) => n.session_id),
  ["sdkB"],
  "host B's SDK nested session attaches only to host B's key, not host A's"
);

// isRepeatPress must not let a window on one host answer for a session on
// another. Both fall back to the folder rule when no window publishes, and that
// rule compares paths — which two hosts can share.
const localPress = { index: 0, session_id: "a", folder: "/home/pi/x", host: null };
const remotePress = { index: 1, session_id: "b", folder: "/home/pi/x", host: "192.168.2.6" };
eq(isRepeatPress(remotePress, localPress, []), false, "a remote press does not make a local press at the same path a repeat");
eq(isRepeatPress(localPress, localPress, []), true, "the same local session at the same path still repeats");

// A published window on the wrong host must not satisfy the reveal test. The
// previous press carries a different session_id than the current one, so the
// live-reveal branch (which needs previous.session_id === press.session_id)
// can only return true here by way of the host-scoped fallback — a filter
// that let remoteWindow through would land in the live-reveal branch instead
// and answer false, which is how this assertion actually pins the guard
// rather than passing regardless of it.
const remoteWindow = { pid: 1, folders: ["/home/pi/x"], focused: true, activeSessionId: "a", host: "192.168.2.6" };
const previousDifferentSession = { ...localPress, session_id: "different" };
eq(
  isRepeatPress(previousDifferentSession, localPress, [remoteWindow]),
  true,
  "a window on another host is ignored, so the local folder rule still answers"
);

// A remote key can never be revealed (spec B is deferred), so its detail board
// must still be reachable on a second press even though no window will ever
// report it `activeSessionId`. Before the fix, `focusWindow` returns before
// A remote session is now revealable, so it takes the ordinary path: the second
// press opens the board only once the window has reported the reveal actually
// landed. This replaces a guard that short-circuited every remote press to the
// folder rule — correct only while a remote reveal was impossible, and wrong
// the moment it became possible. The guard would have made a *sibling* remote
// key in the same folder read as a repeat, so a project's second remote session
// would open the detail board instead of revealing its own terminal: the exact
// failure the repeat-press rule was rewritten to fix for local sessions.
const remotePress2 = { index: 5, session_id: "r1", folder: "/home/pi/x", host: "192.168.2.6" };
const remoteRevealed = { pid: 2, folders: ["/home/pi/x"], focused: true, activeSessionId: "r1", host: "192.168.2.6" };
const remoteNotYet = { pid: 2, folders: ["/home/pi/x"], focused: true, activeSessionId: null, host: "192.168.2.6" };
eq(
  isRepeatPress(remotePress2, remotePress2, [remoteRevealed]),
  true,
  "a remote second press opens detail once the window reports the reveal landed"
);
eq(
  isRepeatPress(remotePress2, remotePress2, [remoteNotYet]),
  false,
  "but not while the reveal has not landed yet — that press still has work to do"
);
// The sibling case the removed guard broke: two remote sessions in one folder.
const remoteSibling = { index: 6, session_id: "r2", folder: "/home/pi/x", host: "192.168.2.6" };
eq(
  isRepeatPress(remotePress2, remoteSibling, [remoteRevealed]),
  false,
  "pressing a sibling remote key is a new first press, not a repeat of its neighbour"
);


// ---------------------------------------------------------------------------
// boardTiles: the same grouping the deck's slots get, without the deck's cap.
// The board page is the one view with no slot truncation at all, so what has to
// hold here is that nothing *else* changed — order, the primary-key rule, and
// the state folding all still come out as the keys beside it.
{
  const bslots = new Array(12).fill(null);
  const bnested = new Array(12).fill(null);
  // `cwd` is not optional here: keyFields' last fallback is its basename, and
  // every session out of the registry has one.
  const sess = (id, folder, extra = {}) => ({ session_id: id, folder, cwd: folder, nested: false, state: "idle", ...extra });
  const sub = (id, folder, parent, state) => ({ session_id: id, folder, nested: true, parent, state });
  // Fourteen sessions across two projects: more than the deck can show, which
  // is the whole reason this view exists.
  const many = [
    ...Array.from({ length: 8 }, (_, i) => sess(`a${i}`, A)),
    ...Array.from({ length: 6 }, (_, i) => sess(`b${i}`, B)),
  ];
  assignSlots(many, bslots, bnested);
  const tiles = boardTiles(many);
  eq(tiles.length, 14, "every session gets a tile, past the deck's twelve");
  eq(
    tiles.slice(0, 3).map((t) => t.id),
    ["a0", "a1", "a2"],
    "and in the deck's own first-seen order, project by project"
  );
  eq(tiles.at(-1).id, "b5", "including the two the deck had no slot for");

  // A subagent colours the key of the session that spawned it, and only that
  // one — the bug folder-attachment shipped with, which nothing but a deck or
  // this page would show.
  const withAgent = [sess("a0", A), sess("a1", A), sub("g1", A, "a1", "busy")];
  assignSlots(withAgent, bslots, bnested);
  const folded = boardTiles(withAgent);
  eq(
    folded.map((t) => [t.id, t.state, t.nested]),
    [["a0", "idle", []], ["a1", "busy", ["busy"]]],
    "a busy subagent colours its own parent's tile, not its sibling's"
  );

  // `shell` is carried apart from `state` for the same reason renderKey takes
  // it apart: a tile greened by a subagent must not lose its own shell marker.
  const shelly = [sess("a0", A, { state: "shell" }), sub("g2", A, "a0", "busy")];
  assignSlots(shelly, bslots, bnested);
  eq(boardTiles(shelly).map((t) => [t.state, t.shell]), [["busy", true]], "a shell session keeps its marker under a busy fold");

  // Task squares come from the same taskSquares the deck draws with — the
  // square after the done run is the running one.
  const tasked = [sess("a0", A, { progress: { current: 3, total: 5, active: true } })];
  assignSlots(tasked, bslots, bnested);
  eq(boardTiles(tasked)[0].squares.map((q) => q.state), ["done", "done", "active", "todo", "todo"], "task squares match the deck's");

  // An unreachable host keeps its block's place and accent and says so; it is
  // never a session tile, so nothing can try to focus it.
  const down = [sess("a0", A)];
  assignSlots(down, bslots, bnested);
  const mixed = boardTiles(down, [{ session_id: "u", folder: B, host: "pi", unreachable: true, state: "idle", ts: 1000 }], 1240);
  eq(mixed.map((t) => t.kind), ["session", "offline"], "a stand-in is its own kind, never a tappable session");
  eq(mixed[1].label, "pi offline 4m", "and says which host, and for how long");
}


// ---------------------------------------------------------------------------
// The status key: two queues on one key, because they are never both the
// answer. "10 free" is not what you want to read while two sessions are
// blocked on you, and once nothing is blocked the blocked count is a zero
// nobody needs a key for. Invisible without the hardware, which is why the
// fold is a pure function rather than a branch inside a draw call.
{
  const NOW = 1000;
  const q = (n, age) => Array.from({ length: n }, (_, i) => ({ session_id: `q${i}`, ts: NOW - age + i }));

  eq(statusKey(q(2, 360), q(9, 3000), NOW), { kind: "attention", count: 2, longest: "6m" },
     "anything blocked wins, however much capacity is free");
  eq(statusKey([], q(9, 3000), NOW), { kind: "free", count: 9, longest: "50m" },
     "nothing blocked falls back to the free queue");
  eq(statusKey([], q(9, 3000), NOW, 71), { kind: "memory", pct: 71 }, "memory pressure over the line outranks free");
  eq(statusKey(q(2, 360), [], NOW, 99).kind, "attention", "but never a session blocked on you");
  eq(statusKey([], q(9, 3000), NOW, 70).kind, "free", "at the line is not over it");
  eq(statusKey([], [], NOW), { kind: "free", count: 0, longest: "" },
     "neither is a dark key that opens nothing, not a missing one");
  // The age is the *oldest* of that queue, which is what both renderers put
  // under the count — attentionQueue and freeQueue each sort longest-first, so
  // it is the head either way.
  eq(statusKey(q(3, 7200), [], NOW).longest, "2h00m", "the age comes off the head of whichever queue is showing");
  // A queue entry with no usable timestamp draws no age rather than one
  // counted from the epoch, same rule keyFields follows.
  eq(statusKey([{ session_id: "x", ts: 0 }], [], NOW).longest, "", "a session with no timestamp reports no age");
}

console.log("OK: project grouping, board tiles, status key");
