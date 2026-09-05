// Verifies project grouping: sessions for one VS Code window sit in one
// contiguous block, project order and within-project order are both pinned to
// first-seen, and nothing re-sorts by activity.
// Run: node scripts/slots-check.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignSlots, accentFor, boardTiles, statusKey, pageOf, restartDecision, reconnectDecision, headlessDeck, resumeView, seedSessionOrder, stillUnread, markSeen, loadAccents, attentionQueue, freeQueue, busyQueue, busyBoardTiles, leavingFraction, BUSY_LEAVE_MS, detailLayout, holdTiles, mostUrgent, isRepeatPress, DETAIL_BACK_INDEX, folderKeyFor, ACCENTS } from "../src/index.mjs";
import { readProjects, writeProjects, applyAccentChoice, moveProject } from "../src/accents.mjs";
import { recentlyIdle, RECENT_IDLE_S, SPLASH_LETTERS, SPLASH_MS } from "../src/render.mjs";

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

// At the cap, first-seen alone hides the session actually doing the work:
// the board is full, and the busy one is the one that arrived last. This is
// the only place activity is allowed to move a key, and it trades strictly
// within the project — the block keeps its slots, one of them changes hands.
{
  const [P, Q, R, S2, T, U] = ["gamma", "delta", "epsilon", "zeta", "eta", "theta"].map((n) => `/projects/${n}`);
  const act = (id, folder, state, ts = 0) => ({ session_id: id, folder, nested: false, state, ts });

  // Nothing is cut, so nothing moves however busy the tail is.
  const three = new Array(3).fill(null);
  assignSlots([act("c1", P, "idle"), act("c2", P, "busy"), act("c3", P, "busy")], three);
  eq(three, ["c1", "c2", "c3"], "inside the cap, first-seen is untouched");

  // c4 doesn't fit. It's busy and c1 is idle, so it takes c1's slot — not the
  // end of the block, and not anybody else's.
  assignSlots([act("c1", P, "idle"), act("c2", P, "busy"), act("c3", P, "busy"), act("c4", P, "busy")], three);
  eq(three, ["c4", "c2", "c3"], "a busy session past the cap takes the idle sibling's slot");

  // Two cut, one visible idle: only the most urgent of them gets in, and the
  // order the cut sessions arrive in must not decide which.
  const two = new Array(2).fill(null);
  const pool = [act("d1", Q, "idle"), act("d2", Q, "busy"), act("d3", Q, "requires_action"), act("d4", Q, "busy")];
  assignSlots(pool, two);
  eq(two, ["d3", "d2"], "the most urgent of the cut sessions wins the slot");
  assignSlots([pool[0], pool[3], pool[2], pool[1]], two);
  eq(two, ["d3", "d2"], "and input order doesn't change that");

  // Same state on both sides is not a reason to move a key: first-seen still
  // has an answer, so it keeps it. Only ts breaks a genuine tie.
  const one = new Array(1).fill(null);
  assignSlots([act("e1", R, "busy", 500), act("e2", R, "busy", 100)], one);
  eq(one, ["e1"], "an equally-busy sibling that has been at it longer isn't evicted");
  assignSlots([act("e1", R, "busy", 100), act("e2", R, "busy", 500)], one);
  eq(one, ["e2"], "a fresher one is");

  // A busy Agent-tool subagent is the case this was written for: its parent
  // reads busy on its key, so it has to rank busy here too.
  const twoNested = new Array(2).fill(null);
  assignSlots(
    [
      act("f1", S2, "idle", 900),
      act("f2", S2, "idle", 800),
      act("f3", S2, "idle", 700),
      { session_id: "sub", folder: S2, nested: true, parent: "f3", state: "busy", ts: 700 },
    ],
    twoNested
  );
  // f2 rather than f1: among equally idle siblings the one that went quiet
  // first is the least active, so it is the one that gives up its slot.
  eq(twoNested, ["f1", "f3"], "a session whose subagent is working outranks its idle siblings");

  // A project cut off entirely has no sibling of its own to trade with, so
  // promoteActive alone can't reach it — that's what guaranteeRepresentation
  // is for (see below). T holds both slots and gives up its oldest (g1) to
  // seat U; promoteActive then can't bring g1 back either, since g1 and g2
  // tie on state and ts and a tie never swaps.
  const twoProjects = new Array(2).fill(null);
  assignSlots([act("g1", T, "idle", 100), act("g2", T, "idle", 100), act("h1", U, "requires_action", 900)], twoProjects);
  eq(twoProjects, ["g2", "h1"], "every project keeps at least one slot");
}

// guaranteeRepresentation: a project with nothing visible steals a slot from
// whichever project currently holds the most, taking that project's oldest
// (first-seen) session — never its newest, and never a project down to one.
{
  const [V, W, X] = ["iota", "kappa", "lambda"].map((n) => `/projects/${n}`);

  // V has three sessions, W has one, and only two slots exist — first-seen
  // alone would fill both with V and leave W with nothing.
  const two2 = new Array(2).fill(null);
  assignSlots([s("v1", V), s("v2", V), s("v3", V), s("w1", W)], two2);
  eq(two2, ["v2", "w1"], "the starved project bumps the donor's oldest, not its newest");

  // Two starved projects (W, X) sharing one donor (V) that started with all
  // three slots: V can give one up twice before it's down to one itself, so
  // both W and X get seated.
  const three3 = new Array(3).fill(null);
  assignSlots([s("v1", V), s("v2", V), s("v3", V), s("w1", W), s("x1", X)], three3);
  eq(three3, ["v3", "w1", "x1"], "a big enough donor can seat more than one starved project");

  // No donor exists once every visible project already holds exactly one
  // slot — there's nothing to spare, so a fourth project is left with
  // nothing rather than starving a sibling down to zero to make room for it.
  const two3 = new Array(2).fill(null);
  assignSlots([s("v1", V), s("w1", W), s("x1", X)], two3);
  eq(two3, ["v1", "w1"], "no spare slot means a project can still be left out");
}
// A whole project going away closes its gap.
assignSlots([s("b1", B)], slots);
eq(slots, ["b1", null, null, null, null], "empty project leaves no gap");

// ...and returning reclaims its original position ahead of beta, because
// folder order is remembered.
assignSlots([s("b1", B), s("a9", A)], slots);
eq(slots, ["a9", "b1", null, null, null], "returning project keeps its place");

// Board full: an extra session within an already-represented project simply
// gets no button (b1 has no siblings, so it's the whole story here); a
// session from a project not yet represented would instead be the
// guarantee's business — see the guaranteeRepresentation block below.
const small = new Array(2).fill(null);
assignSlots([s("a1", A), s("a2", A)], small);
eq(small, ["a1", "a2"], "full board drops extras within a represented project");

// Same board, but B's only session was cut instead of never arriving — A
// still holds both slots, so its oldest gives one up rather than leaving B
// with nothing.
assignSlots([s("a1", A), s("a2", A), s("b1", B)], small);
eq(small, ["a2", "b1"], "a starved project still gets a slot on a full board");

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
const roundNames = new Map([["/projects/x", "Renamed X"]]);
writeProjects(roundAccents, ["pi:/home/pi/x", "/projects/x"], roundNames, accentDir);
eq([...readProjects(accentDir).accents], [...roundAccents], "accents round-trip");
eq(readProjects(accentDir).order, ["pi:/home/pi/x", "/projects/x"], "and so does the order, not the write order");
eq([...readProjects(accentDir).names], [...roundNames], "and a rename, for a project that has one");
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
// `recent` rides along so the key you land on is drawn exactly like the key
// you pressed. This session is busy, so it is false whatever its `ts` says.
eq(
  plain[0],
  { kind: "label", label: "serializing client-block mutations", project: "kob-trace", recent: false },
  "the title is one key, the session's own"
);
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
eq(cleared[0], { kind: "label", label: "", project: "kob-trace", recent: false }, "cleared session shows no title");

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
  { kind: "label", label: "process the backend change queue", project: "kob-trace", recent: false },
  "an untitled session reads as what you asked it"
);
eq(
  layout({ ...untitled, aiTitle: "Drain the change queue", lastPrompt: "process the backend change queue" }),
  { kind: "label", label: "Drain the change queue", project: "kob-trace", recent: false },
  "and hands over to the title once one exists"
);
eq(
  layout(untitled),
  { kind: "label", label: "kob-trace-01", project: "kob-trace", recent: false },
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

  eq(statusKey(q(2, 360), 14, NOW), { kind: "attention", count: 2, longest: "6m" },
     "anything blocked wins, however many sessions are running");
  // The resting readout is the *total*, because the key names the board it is
  // sitting on: SESSIONS here, FREE and WORKING on the two boards its own
  // cycle opens. No age line — "longest idle" says something under a free
  // count and nothing under a total.
  eq(statusKey([], 14, NOW), { kind: "sessions", count: 14 },
     "nothing blocked rests on how many sessions there are");
  const P = (local, pi) => [{ host: null, pressure: local }, { host: "pi", pressure: pi }];
  eq(statusKey([], 14, NOW, P(71, 20)), { kind: "memory", pct: 71, host: null }, "memory pressure over the line outranks the resting count");
  eq(statusKey([], 14, NOW, P(72, 90)), { kind: "memory", pct: 90, host: "pi" }, "the worst machine is the one named");
  eq(statusKey(q(2, 360), 0, NOW, P(99, 99)).kind, "attention", "but never a session blocked on you");
  eq(statusKey([], 14, NOW, P(70, null)).kind, "sessions", "at the line is not over it, and unknown is not over it");
  eq(statusKey([], 0, NOW), { kind: "sessions", count: 0 },
     "an empty machine is a dark key that opens nothing, not a missing one");
  // The age is the *oldest* of the attention queue, which is what renderAttention
  // puts under the count — attentionQueue sorts longest-first, so it is the head.
  eq(statusKey(q(3, 7200), 0, NOW).longest, "2h00m", "the age comes off the head of the queue being shown");
  // A queue entry with no usable timestamp draws no age rather than one
  // counted from the epoch, same rule keyFields follows.
  eq(statusKey([{ session_id: "x", ts: 0 }], 0, NOW).longest, "", "a session with no timestamp reports no age");
}

// pageOf: the queue boards page once they overflow the 12 session keys, and
// the status key's own press walks those pages before it walks to the next
// board. The arithmetic is the part that hides an off-by-one, and none of it
// is visible without a deck.
{
  const q = (n) => Array.from({ length: n }, (_, i) => `s${i}`);
  eq(pageOf(q(5), 0, 12), { pages: 1, page: 0, entries: q(5) }, "under the cap is one page, unchanged");
  eq(pageOf([], 0, 12).pages, 1, "an empty queue is still one page, never zero");
  eq(pageOf(q(12), 0, 12).pages, 1, "exactly full is one page");
  eq(pageOf(q(13), 0, 12).entries.length, 12, "the first page fills the keys");
  eq(pageOf(q(13), 1, 12), { pages: 2, page: 1, entries: ["s12"] }, "and the last page holds the remainder");

  // The queues re-rank every poll and shrink under you — the whole point of
  // the attention board. A page that no longer exists must land on one that
  // does, not draw twelve blanks that read as a dead daemon.
  eq(pageOf(q(13), 5, 12).page, 1, "a page past the end clamps to the last");
  eq(pageOf(q(5), 3, 12), { pages: 1, page: 0, entries: q(5) }, "a queue that shrank to one page lands on it");
  eq(pageOf(q(13), -2, 12).page, 0, "and never below the first");
  eq(pageOf(q(13), undefined, 12).page, 0, "a missing page is the first one");
}

// restartDecision: the daemon replaces itself with the build on disk when the
// version moves. The exec is unrepeatable — you get one process — so the part
// worth pinning is the four-argument decision in front of it.
{
  const V = "1.6.0";
  const settle = 5000;
  eq(restartDecision(V, V, 0, 1000, settle), { since: 0, restart: false }, "the same version is not news");

  // A git pull is not atomic: package.json can land before the files it
  // belongs with, so a changed version starts a clock rather than a restart.
  const first = restartDecision(V, "1.7.0", 0, 1000, settle);
  eq(first, { since: 1000, restart: false }, "a new version starts the settle window");
  eq(restartDecision(V, "1.7.0", 1000, 4000, settle).restart, false, "and does not fire inside it");
  eq(restartDecision(V, "1.7.0", 1000, 6000, settle).restart, true, "but does once it has settled");
  eq(restartDecision(V, "1.7.0", 1000, 6000, settle).since, 1000, "measured from when it first differed, not the last look");

  // Mid-write is the normal state of a file another process is rewriting, and
  // it must neither restart nor reset the window it is sitting inside.
  eq(restartDecision(V, null, 1000, 6000, settle), { since: 1000, restart: false }, "an unreadable package.json waits");
  eq(restartDecision(V, null, 0, 1000, settle), { since: 0, restart: false }, "and starts nothing on its own");

  // An edit that lands back on what we are running — a branch switched away
  // and back — closes the window rather than leaving it half-open.
  eq(restartDecision(V, V, 1000, 4000, settle).since, 0, "returning to our own version clears the clock");
}

// reconnectDecision: a replugged deck must come back on its own. The device
// list is the only witness — neither half of this raises an event worth
// waiting for — and none of it is visible without hardware to pull out.
{
  const A = "DevSrvsID:1", B = "DevSrvsID:2";
  eq(reconnectDecision(null, []), false, "a headless run with nothing plugged in stays headless");
  eq(reconnectDecision(null, [A]), true, "and hands back the moment a deck appears");

  eq(reconnectDecision(A, [A]), false, "a run driving its own deck keeps driving it");
  eq(reconnectDecision(A, []), true, "an unplugged deck is gone even if `error` never fired");
  // The path changes across a replug, so "some deck is listed" is not the
  // question — a pull and a push between two polls must still read as gone,
  // or the run keeps writing to a handle that no longer resolves.
  eq(reconnectDecision(A, [B]), true, "and a replug between two polls is a different path, not ours");
}

// headlessDeck: the stand-in the board page runs behind. Fifteen MK.2-shaped
// keys, and every draw path silently swallowed.
{
  const d = headlessDeck();
  eq(d.CONTROLS.length, 15, "the stand-in has the MK.2's key count");
  eq(d.CONTROLS.every((c) => c.type === "button" && c.pixelSize.width === 72), true, "with the MK.2's key size");
}

// seedSessionOrder: first-seen order carried across a restart, so a session
// keeps its key. Seeded ids sort ahead of anything that arrives afterwards.
{
  const P = "/projects/seeded";
  const three = new Array(3).fill(null);
  // Deliberately the reverse of the order assignSlots would pick from input.
  seedSessionOrder(["z", "y"]);
  assignSlots([s("x", P), s("y", P), s("z", P)], three);
  eq(three, ["z", "y", "x"], "remembered order wins, and a session that wasn't remembered lands after");
}

// recentlyIdle: which of the two greys a key gets. Only `idle` splits — every
// other state keeps the colour it always had — and it is the same function
// both boards call, so the deck and the iPad cannot disagree about a key.
{
  const now = 10_000;
  const sess = (state, ts, extra = {}) => ({ state, ts, ...extra });
  eq(recentlyIdle(sess("idle", now - 60), now), true, "idle a minute ago is recent");
  eq(recentlyIdle(sess("idle", now - RECENT_IDLE_S + 1), now), true, "and right up to the edge");
  eq(recentlyIdle(sess("idle", now - RECENT_IDLE_S), now), false, "but not at it");
  eq(recentlyIdle(sess("idle", now - 3600), now), false, "an hour of sitting is not recent");

  // Every other state keeps its own colour: this only ever splits idle in
  // two, so a busy key is green whether it started ten seconds or ten hours
  // ago, and a blocked one stays red.
  for (const state of ["busy", "shell", "waiting", "requires_action", "compacting"]) {
    eq(recentlyIdle(sess(state, now - 60), now), false, `${state} is not affected`);
  }

  // "Recently active" has to mean active. A session nobody has typed into has
  // a fresh ts from the moment it registered and has done nothing at all —
  // opening a window would otherwise light a key for five minutes.
  eq(recentlyIdle(sess("idle", now - 60, { startedEmpty: true }), now), false, "a session never typed into is not recent");
  // `/clear` is an ordinary turn: the session goes idle and restamps ts with
  // nothing behind it, so the key would promise something to read on top of
  // the word CLEAR. Same two flags keyFields lets blank a key's body.
  eq(recentlyIdle(sess("idle", now - 60, { clearedEmpty: true }), now), false, "a cleared session is not recent");
  // No ts is a registry entry that could not be read: absent, not new.
  eq(recentlyIdle(sess("idle", 0), now), false, "a missing timestamp is not recent");
  eq(recentlyIdle(null, now), false, "and neither is nothing at all");
}

// The restart splash: fifteen letters, fifteen keys, no remainder. If a word
// changes, this is what says so before the deck does.
eq(SPLASH_LETTERS.length, 15, "one letter per key, exactly");
eq(SPLASH_LETTERS.join(""), "NEWVERSIONSTART", "and they spell it in reading order");
// Four seconds for the whole sweep, so the per-letter interval is derived.
// A word added without touching SPLASH_MS must not stretch the restart.
eq(SPLASH_MS, 4000, "the sweep is four seconds, whatever the letter count");

// resumeView: the board a restart lands back on, carried through execve in
// the environment — the only thing that survives replacing the process image.
{
  eq(resumeView(JSON.stringify({ kind: "stats" })), { kind: "stats" }, "a board comes back");
  eq(resumeView(JSON.stringify({ kind: "detail", session_id: "abc" })), { kind: "detail", session_id: "abc" }, "detail keeps its session");
  // tiles are recaptured on the new process's first poll (holdTiles), and a
  // queue page is deliberately dropped: landing on page 3 of a queue that
  // re-ranked while the daemon restarted is a page nobody chose.
  eq(resumeView(JSON.stringify({ kind: "free", page: 2 })), { kind: "free" }, "a queue board comes back on page one");

  // This value reaches the poll loop's own board dispatch, so it is a closed
  // set: a kind that is not a board leaves the daemon drawing nothing at all.
  eq(resumeView(JSON.stringify({ kind: "sessions" })), null, "the default board is not resumed, it is the fallback");
  eq(resumeView(JSON.stringify({ kind: "../etc" })), null, "an unknown kind is refused");
  eq(resumeView(JSON.stringify({ kind: "detail" })), null, "detail without a session has nothing to draw");
  eq(resumeView(JSON.stringify({ kind: "detail", session_id: 7 })), null, "and its id must be a string");
  eq(resumeView(undefined), null, "no variable is an ordinary start");
  eq(resumeView("not json"), null, "and neither is nonsense");
}

// The purple key means "this stopped and you have not looked at it yet", so
// pressing it is what answers the question. stillUnread is the board's half of
// that; recentlyIdle above is the palette's.
{
  const now = Date.now() / 1000;
  const sess = { session_id: "seen-me", state: "idle", ts: now - 30 };
  eq(stillUnread(sess), true, "a session that just stopped is unread");
  markSeen(sess);
  eq(stillUnread(sess), false, "and pressing its key drops it to plain idle");

  // Compared against ts, not against a clock. A ts *after* the visit is a
  // session that worked again and stopped again since you were last there, so
  // the key has something new to say — which is the whole reason the mark is a
  // timestamp and not a boolean. (Written as a ts in the near future because
  // the visit above was stamped from the real clock a line ago; there is no
  // way to be "30 seconds later" in a check that does not sleep.)
  eq(stillUnread({ ...sess, ts: now + 30 }), true, "stopping again since the visit is new news");

  // A visit cannot make a key purple that wasn't, and never overrides the
  // palette's own rule.
  markSeen({ session_id: "busy-one", ts: now });
  eq(stillUnread({ session_id: "busy-one", state: "busy", ts: now - 30 }), false, "a busy session is still busy");
  eq(stillUnread({ session_id: "never-pressed", state: "idle", ts: now - 3600 }), false, "and a long-idle one is still grey");

  // Nothing to mark is not an error: the queue boards call this on their way
  // out, where a press can land on an empty key.
  markSeen(null);
  markSeen({});
}

console.log("OK: project grouping, board tiles, status key");

// A session leaving the working board drains rather than vanishing. None of
// this is visible without the hardware *and* a session finishing while you
// happen to be on that board, which is exactly the combination nobody
// reproduces on purpose — so the arithmetic is a pure function with its own
// map, and this is what drives it.
{
  const T = 1_000_000;
  const sess = (id, state, ts) => ({ session_id: id, state, ts, nested: false, folder: "/p", host: null });
  // ts is in seconds everywhere else in this file; only the ordering uses it,
  // so the units just have to be consistent within the case.
  const a = sess("a", "busy", 100);
  const b = sess("b", "busy", 200);
  const hold = new Map();

  let tiles = busyBoardTiles([a, b], [a, b], hold, T);
  eq(tiles.map((t) => t.session.session_id), ["a", "b"], "both busy sessions are on the board, longest-busy first");
  eq(tiles.every((t) => t.leavingUntil === null), true, "and neither is leaving");

  // `a` stops working. Its live record restamps ts — going idle is a state
  // change — which is exactly why ordering uses the remembered busy-time one.
  const aIdle = sess("a", "idle", 999);
  tiles = busyBoardTiles([b], [aIdle, b], hold, T + 1000);
  eq(tiles.map((t) => t.session.session_id), ["a", "b"], "it holds its place rather than being flung to the end");
  eq(tiles[0].leavingUntil, T + 1000 + BUSY_LEAVE_MS, "with an absolute deadline, so poll and pulse agree");
  eq(tiles[0].session.state, "idle", "drawn as what it now is, not as what it was");
  eq(tiles[1].leavingUntil, null, "the one still working is untouched");

  // The deadline does not restamp on every poll — that would hold it forever.
  tiles = busyBoardTiles([b], [aIdle, b], hold, T + 3000);
  eq(tiles[0].leavingUntil, T + 1000 + BUSY_LEAVE_MS, "the countdown started when it stopped, not on the poll that noticed again");

  // ...and once it runs out, the tile is gone and the map has forgotten it.
  tiles = busyBoardTiles([b], [aIdle, b], hold, T + 1000 + BUSY_LEAVE_MS);
  eq(tiles.map((t) => t.session.session_id), ["b"], "the drained session drops off");
  eq(hold.has("a"), false, "and is not remembered past its own hold");

  // Back to work inside the hold: no drain, no ghost.
  const hold2 = new Map();
  busyBoardTiles([a, b], [a, b], hold2, T);
  busyBoardTiles([b], [sess("a", "idle", 999), b], hold2, T + 1000);
  const back = busyBoardTiles([a, b], [a, b], hold2, T + 2000);
  eq(back.find((t) => t.session.session_id === "a").leavingUntil, null, "a session that goes busy again stops leaving");

  // A session that *ends* is gone, not leaving — there is no key to drain and
  // holding one would be the board claiming something is running that isn't.
  const hold3 = new Map();
  busyBoardTiles([a, b], [a, b], hold3, T);
  const ended = busyBoardTiles([b], [b], hold3, T + 1000);
  eq(ended.map((t) => t.session.session_id), ["b"], "a session that disappeared entirely never drains");
  eq(hold3.has("a"), false, "and is dropped from the map on the spot");

  // The fraction both clocks read off one deadline.
  eq(leavingFraction(T + BUSY_LEAVE_MS, T), 1, "a fresh departure draws a full bar");
  eq(leavingFraction(T + BUSY_LEAVE_MS, T + BUSY_LEAVE_MS / 2), 0.5, "half way through, half a bar");
  eq(leavingFraction(T, T + 9999), 0, "past the deadline it is empty, never negative");
  eq(leavingFraction(null, T), null, "and a tile that is not leaving has no bar at all");
}
console.log("OK: working-board departures");
