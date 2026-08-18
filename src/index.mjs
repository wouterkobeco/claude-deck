import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import { getLiveSessions, localSource, matchFolder, readTaskList, taskWindow } from "./sessions.mjs";
import { fetchSource } from "./remote-fs.mjs";
import { cachedSources, remoteSources, unreachableHosts } from "./remote-hosts.mjs";
import { openFileIn } from "./vscode-state.mjs";
import { requestFocus } from "./terminal-focus.mjs";
import { publishSessions } from "./publish-sessions.mjs";
import { openConfig } from "./config-server.mjs";
import { readHistory, recordStates, startOfDay, summarise, trimHistory } from "./history.mjs";
import { ACCENTS, applyAccentChoice, moveProject, readProjects, writeProjects } from "./accents.mjs";
import { countVsCodeWindows, readWindowStates } from "./window-state.mjs";
import { renderKey, renderBlank, renderUsage, renderStat, renderAttention, renderTask, renderBack, renderCompacting, formatAge, CONTEXT_CRITICAL } from "./render.mjs";
import { getUsage, daysUntil, hoursUntil } from "./usage.mjs";
import { getStats } from "./stats.mjs";

// One source of truth for the version — read from package.json rather than
// duplicated here, so a bump is one edit. Read rather than imported with
// `with { type: "json" }`: that syntax is parsed before anything runs, so on a
// Node without it the daemon and every check that imports this file fail
// outright rather than degrading, and nothing here declares that floor.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const POLL_MS = 2000;
const RECONNECT_MS = 5000;
// ~2.5fps: fast enough to read as a pulse, slow enough not to flood the deck's
// USB HID link across up to 14 keys at once (13 session keys plus the
// attention key).
const PULSE_MS = 400;
// requires_action's own beat: dark gold at rest, one PULSE_MS-wide flash to
// bright gold every REQUIRES_ACTION_FLASH_MS — a blip, not a 50/50
// alternation, so timed against the wall clock rather than the tick counter.
const REQUIRES_ACTION_FLASH_MS = 4000;
// The attention key blinks to announce a *new* waiter, then settles to solid
// red — a key that flashes for an hour stops meaning anything.
const ATTENTION_BLINK_MS = 5000;
const ANCHOR_CANDIDATES = ["package.json", "README.md", "AGENTS.md", "CLAUDE.md", ".gitignore"];

// Defined in accents.mjs, not here: config-server.mjs needs the palette, and
// this file needs openConfig from config-server.mjs — one of those two edges
// has to not exist. Re-exported so colors-check and slots-check keep importing
// it from here.
export { ACCENTS };

// First-seen order for both grouping and colour, so a project's block and its
// stripe always agree. Folders are kept after their last session ends: if the
// project comes back it reclaims its old position and colour instead of
// jumping to the end.
//
// The array is the truth and `folderOrder` is a derived index, rebuilt
// whenever it changes: a project's position used to be a counter taken at
// first sight, which cannot express "third, because you dragged it there".
// An array can, and it makes the two invalid states unrepresentable — a
// project can't hold two positions, and two can't hold one.
const projectOrder = [];
const folderOrder = new Map();
function reindexProjects() {
  folderOrder.clear();
  projectOrder.forEach((key, i) => folderOrder.set(key, i));
}

const sessionOrder = new Map();
const nestedOrder = new Map();
let arrivals = 0;

// One entry per remote host: its last fetch, its consecutive failures, and the
// source that fetch produced. Held here for the daemon's lifetime, like
// folderOrder — a host that goes away is evicted by remoteSources().
const remoteMemo = new Map();
// Not os.tmpdir(): on macOS that's a long per-user path under /var/folders,
// and fetchSource's ControlPath socket (that path, plus "cm-<host>", plus
// ssh's own random suffix while the bind is in flight) blows the ~104-byte
// Unix domain socket limit — measured live: ssh fails with `unix_listener:
// path "...too long for Unix domain socket"` on every fetch, every time,
// silently reported by fetchSource as an ordinary "host unreachable". /tmp is
// a short, stable symlink on macOS and this daemon is macOS-only already.
const SCRATCH_ROOT = `/tmp/streamdeck-remote-${process.pid}`;

// Every session-reading poll goes through this rather than calling
// getLiveSessions() bare: a remote key only exists because its source made it
// into this list. SSH is on no critical path: a fetch is two ssh calls, each
// bounded by a 15s hard kill, and awaiting it here would pause every local
// key's redraw for as long as some remote host is unreachable — a Raspberry
// Pi going quiet must not freeze the board it shares with real projects. So
// the fetch is started, not awaited, and this returns whatever the last one
// produced. Cost: the first poll after a remote window appears shows no
// remote key until that fetch lands. Freshness, not frames.
function allSources() {
  const windows = readWindowStates();
  // remoteSources() cannot reject on its own (every host's fetch is caught
  // individually), but this call is unwatched — nothing here is in a position
  // to catch a rejection, so an uncaught one would take the whole daemon down
  // rather than just a poll tick. Belt, not suspenders.
  void remoteSources(windows, Date.now(), remoteMemo, (host) => fetchSource(host, SCRATCH_ROOT)).catch(() => {});
  return [localSource(), ...cachedSources(windows, remoteMemo)];
}

// Every folder with a live session: what the config page lists, and what the
// accent swap searches for a colour's current owner.
//
// Rebuilt in liveSessions() rather than in assignSlots, which runs only from
// refresh() — i.e. only on sessions-board polls. A config page left open while
// you toggle to the stats or detail board would otherwise be picking against a
// frozen set, and a project that appeared since would be invisible to the
// owner search, minting exactly the live-live duplicate the swap exists to
// prevent.
//
// All live folders, not the visible 13: a project past the slot cap has no key
// yet but will, and it must not be invisible to that search. attentionQueue is
// passed the whole session list for the same reason.
const liveProjects = new Map();

// The single session read, so that publishing the list for the extension's
// restore command happens on every poll rather than on the polls of whichever
// board happens to be up. Every branch of the loop reads sessions; only this
// one writes them out.
async function liveSessions() {
  const sessions = await getLiveSessions(allSources());
  liveProjects.clear();
  for (const s of sessions) {
    if (s.nested) continue;
    const key = folderKeyFor(s);
    // The same basename the key's caps bar shows: a project is named by its
    // window's folder, never by a session's cwd.
    if (!liveProjects.has(key)) {
      liveProjects.set(key, { name: s.folder.split("/").filter(Boolean).pop() ?? "", host: s.host ?? null });
    }
  }
  // Not awaited: the file is for a window that has not restarted yet, so it is
  // never worth a frame. void-and-catch for the same reason as above — an
  // unwatched rejection would take the daemon down, and this one can only be a
  // filesystem that isn't answering.
  void publishSessions(sessions).catch(() => {});
  recordHistory(sessions);
  return sessions;
}

// State-history capture, hung off the one session read so it happens on every
// poll rather than on the polls of whichever board is up — the same reasoning
// publishSessions is here for. Only writes when something changed.
const lastStates = new Map();
let historyDay = 0;
function recordHistory(sessions) {
  const now = Date.now();
  recordStates(sessions, lastStates, now);
  // Trimming is a whole-file rewrite, so it runs at startup (historyDay starts
  // at 0) and then once per local day — not on a timer, and never on a poll
  // that isn't already crossing a boundary the summary computes anyway.
  const today = startOfDay(now);
  if (today !== historyDay) {
    historyDay = today;
    const dropped = trimHistory(now);
    if (dropped) console.error(`history: dropped ${dropped} records past the retention window`);
  }
}

// Colour is picked from what no other live folder is using, not from
// ACCENTS[position % 8]. Position grows for the daemon's lifetime and is
// deliberately never pruned, so the modulo guaranteed a collision: once nine
// folders have been seen, positions 0 and 8 are the same colour, and two
// projects sharing one defeats the entire purpose of the accent.
//
// Assigned once, at first sight of a folder, and kept — a project that goes
// away and comes back reclaims its colour, as it reclaims its slot. Since
// accents.mjs, "comes back" includes coming back after a restart: the map is
// seeded from disk by run() and written whenever it changes, so a project's
// colour is as durable as its position in the block.
//
// `taken` is still only what *live* folders are wearing, never what the file
// remembers. Remembering every folder ever seen would exhaust eight colours
// after eight projects and leave every ninth on the modulo fallback; the whole
// reason twenty projects share eight accents is that only the ones on the
// board at once have to differ.
const folderAccent = new Map();
function claimAccent(folder, liveFolders) {
  const taken = new Set([...liveFolders].filter((f) => f !== folder).map((f) => folderAccent.get(f)));
  return ACCENTS.find((c) => !taken.has(c)) ?? ACCENTS[folderAccent.size % ACCENTS.length];
}

/**
 * Seed the remembered accents and project order, from what readProjects()
 * found. Called by run(); the order argument defaults to empty so a check that
 * only cares about colours doesn't have to pass one.
 *
 * The read is deliberately not done at module scope: importing this file must
 * not touch the real ~/.claude, or every check inherits whatever palette this
 * machine happens to be wearing today. Exported for the same reason
 * assignSlots is — none of this is visible without a deck.
 */
export function loadAccents(entries, order = []) {
  for (const [folder, accent] of entries) folderAccent.set(folder, accent);
  projectOrder.length = 0;
  projectOrder.push(...order);
  reindexProjects();
}

/**
 * A folder's identity across the whole board.
 *
 * Two hosts can hold the same path — `/home/pi/x` on two Raspberry Pis is the
 * live case here — and everything that groups a project keys on the folder:
 * block ordering, accent colour, and the "is this the first key of a block"
 * test. Unqualified, those two projects merge into one block wearing one
 * colour, which nothing on the deck explains.
 *
 * A local session's key is the bare folder, so nothing about a machine with no
 * remote hosts changes, including the accent it has been wearing.
 */
export function folderKeyFor(session) {
  return session.host ? `${session.host}:${session.folder}` : session.folder;
}

export function accentFor(folder) {
  return folderAccent.get(folder) ?? ACCENTS[0];
}

// Least to most urgent. A key takes the most urgent state among itself and
// the subsessions folded onto it, so a project whose only activity is in a
// worktree still reads as working. An unrecognised state ranks below all of
// them rather than winning by accident — render.mjs already falls back to
// idle's colour for anything it doesn't know.
const STATE_URGENCY = ["idle", "shell", "busy", "compacting", "waiting", "requires_action"];
export function mostUrgent(states) {
  return states.reduce((best, s) => (STATE_URGENCY.indexOf(s) > STATE_URGENCY.indexOf(best) ? s : best));
}

// Ranked, not ordered: this is the one board that sorts by activity rather
// than first-seen. It's transient triage — you read it, act, and leave — so
// there's no muscle memory for it to break. Nested sessions are in here
// because the queue is the only view that gives them a key at all; on the
// board they're a 3×6px square in someone else's margin.
const ATTENTION_RANK = { requires_action: 0, waiting: 1 };
export function attentionQueue(sessions, nowSeconds) {
  return sessions
    // Not `s.state in ATTENTION_RANK`: `in` walks the prototype chain, so a
    // status of e.g. "constructor" would pass and then sort as NaN.
    // Unreachable given the registry's fixed vocabulary, but free to guard.
    .filter((s) => ATTENTION_RANK[s.state] !== undefined)
    .sort(
      (a, b) =>
        ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state] ||
        (a.ts || nowSeconds) - (b.ts || nowSeconds) ||
        a.session_id.localeCompare(b.session_id)
    );
}

// Picks one stable file inside a folder to use as the focus target. Stable
// matters: opening the *same* file on every press reuses its existing tab
// instead of accumulating a new one each time.
const anchorCache = new Map();
async function anchorFile(folder) {
  if (anchorCache.has(folder)) return anchorCache.get(folder);

  let chosen = null;
  for (const name of ANCHOR_CANDIDATES) {
    try {
      await access(join(folder, name));
      chosen = join(folder, name);
      break;
    } catch {
      // not present — try the next candidate
    }
  }
  if (!chosen) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      const first = entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort()[0];
      if (first) chosen = join(folder, first);
    } catch {
      // unreadable folder — leave chosen null
    }
  }

  anchorCache.set(folder, chosen);
  return chosen;
}

// Focuses the VS Code window owning `folder` by opening a file that lives
// inside it — VS Code routes a file to the window whose workspace contains
// it, which raises that window without creating or replacing one.
//
// Preference is a file that window *already has open* (read from VS Code's
// own state), so focusing adds no tab and normally changes nothing visible.
// The static anchor is the fallback; it does switch the active editor, so
// it's second choice rather than the default.
//
// The obvious alternatives are all worse, verified on this machine:
// `code -r <folder>` reuses *some* open window and replaces its content,
// killing whatever ran there; `open -a Code <folder>` and `vscode://file/...`
// both open an extra window; System Events AXRaise works but requires
// granting Accessibility ("control your computer") to the whole terminal
// app. This route needs no permission at all.
//
// `ide` is the lock file's own `ideName` ("Visual Studio Code", "PhpStorm",
// ...), which doubles as the .app name `open -a` wants. Only VS Code gets the
// already-open-file preference — that comes out of VS Code's own storage, so
// for any other IDE it's the anchor file or nothing.
//
// Raising the window is only half of it when several sessions share one: the
// terminal that's showing may be someone else's. `requestFocus` asks the
// window's own extension to reveal the right one — see
// docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md. It is
// a no-op without the extension installed, which is why it's fired and
// forgotten rather than checked.
async function focusWindow(session, requestedAt) {
  const { folder, ide, host } = session;
  const app = ide ?? "Visual Studio Code";
  // Reveal the session's own terminal inside the window we're about to raise.
  // Not awaited: the two are independent, and a press must not wait on a `ps`
  // call to raise its window.
  //
  // Gated on `app`, not on `ide` — a lock file without an `ideName` yields
  // `ide === null` for a perfectly ordinary VS Code window, so gating on the
  // raw field would silently disable this for most sessions. `app` is the
  // normalised name the line above already computes for exactly this reason.
  //
  // Called here, above `openFileIn`, and specifically before this function's
  // first `await` — `requestFocus`'s own press-order guard takes its sequence
  // number synchronously at call time, so that number has to be stamped in
  // press order. `openFileIn` shells out to `sqlite3` and, on a cold
  // `storageDirCache`, first `readdir`s all of VS Code's `workspaceStorage`;
  // that's hundreds of milliseconds and varies wildly per folder. Call this
  // after `await openFileIn(...)` instead and a press on an already-focused
  // (warm-cache, fast) project can resolve before an earlier press on a
  // cold-cache project — stamping the *earlier* press with the *higher*
  // number, so it wins the guard and the deck reveals the wrong terminal.
  // Keep this above the await.
  //
  // Stamped in the same breath as the request, not after it: `isRepeatPress`
  // uses this to tell "hasn't been revealed yet" from "can never be revealed"
  // (see its docstring), and that's only a fair test starting from when the
  // ask actually went out.
  if (app === "Visual Studio Code") {
    requestedAt?.set(session.session_id, Date.now());
    requestFocus(session);
  }
  const file = app === "Visual Studio Code" ? await openFileIn(folder, host) : null;

  // A remote window is raised through the `code` CLI, not `open`. Its documents
  // are `vscode-remote://` URIs and `open` has no idea what to do with one; the
  // CLI hands the URI to the running instance, which focuses the window that
  // already has that file — no new tab, no new window. `anchorFile` is not a
  // fallback here either: it probes this machine's filesystem for a path that
  // lives on another one. The folder URI is the fallback instead, and it is safe
  // for the same reason the raise is reachable at all — we only get here because
  // a window published this host, so a window with that folder exists to focus.
  //
  // `docs/roadmap-reveal-terminal.md` ruled the `code` CLI out, but for *local*
  // windows, where `open -a` works and `code -r` would replace a window's
  // contents. Neither applies here.
  if (host) {
    // No `--folder-uri` fallback, deliberately. It looks safe — a window
    // published this host, so surely one exists to focus — but `storageDirFor`
    // only ever matches a window's `folder`, and a *multi-root* window records
    // a `workspace` instead. Every press on a session inside one would find no
    // file, fall through, and have `code` match the folder against windows
    // opened *on* that folder rather than windows containing it: a brand new
    // window and a second SSH connection, on every press, not as a race.
    // Skipping the raise costs one half of the press; the reveal above still
    // fires, and CLAUDE.md is explicit that multi-root windows are the case
    // this feature helps most.
    if (!file) {
      console.error(`focus failed for ${host}:${folder}: no open file found to raise its window`);
      return;
    }
    execFile("code", ["--file-uri", file], (err, _stdout, stderr) => {
      if (err) console.error(`focus failed for ${host}:${folder}:`, stderr || err.message);
    });
    return;
  }

  const target = file ?? (await anchorFile(folder));
  if (!target) {
    console.error(`focus failed for ${folder}: no file found to open`);
    return;
  }
  execFile("open", ["-a", app, target], (err, _stdout, stderr) => {
    if (err) console.error(`focus failed for ${folder}:`, stderr || err.message);
  });
}

// Sessions are laid out in contiguous blocks per project, so every button for
// one VS Code window sits together.
//
// This trades away the previous full stickiness, and it has to: keeping a new
// session next to its siblings means inserting it mid-board, which pushes
// later projects along by one. Both orderings are pinned to first-seen so
// that insert is the only movement — projects keep their relative order for
// the daemon's lifetime, and within a project sessions stay in arrival order.
// Nothing re-sorts by activity.
export function assignSlots(sessions, slots, nestedBySlot = []) {
  // Nested means *spawned by another session*, not "in a subdirectory".
  // sessions.mjs decides it from `entrypoint`: `sdk-py`/`sdk-ts` is an agent
  // some other agent started, `cli` is one you started yourself. A cli session
  // gets a key wherever its cwd happens to be — most work here happens in
  // worktrees, and hiding those behind a 3×6px marker hid the main event.
  const real = sessions.filter((s) => !s.nested);
  const nested = sessions.filter((s) => s.nested);

  const liveFolders = new Set(real.map(folderKeyFor));
  // Two folders can arrive remembering the same colour: they were never live
  // at the same time, so neither claim ever saw the other, and the file kept
  // both. On the board that reads as one project, which is the one thing the
  // accent exists to prevent — so the first folder processed keeps it and the
  // later one re-claims, first-seen like everything else here. The re-claim is
  // written back into the map rather than applied per poll, so the loser
  // settles on its new colour instead of flipping every 2s.
  //
  // A manual pick from the config page cannot reach this: `applyAccentChoice`
  // trades with a live owner and deletes a closed one, so the duplicate never
  // enters the map. What is left here is two remembered claims that were never
  // live together, where an arbitrary winner is fine — which is not true of a
  // deliberate choice, hence that delete.
  const used = new Set();
  // This loop is over *sessions*, and the collision rule is about *folders*:
  // a project's second session would otherwise find its own colour already in
  // `used`, evict it, and re-claim the lowest free accent — every poll, so a
  // manual pick from the config page was silently thrown away for any project
  // with two sessions open. Resolved once per folder instead.
  const resolved = new Set();
  for (const s of real) {
    const key = folderKeyFor(s);
    // Still first-seen: a project nobody has dragged goes on the end, exactly
    // as the counter this replaced did.
    if (!folderOrder.has(key)) {
      projectOrder.push(key);
      folderOrder.set(key, projectOrder.length - 1);
    }
    if (!resolved.has(key)) {
      resolved.add(key);
      if (used.has(folderAccent.get(key))) folderAccent.delete(key);
      if (!folderAccent.has(key)) folderAccent.set(key, claimAccent(key, liveFolders));
      used.add(folderAccent.get(key));
    }
    if (!sessionOrder.has(s.session_id)) sessionOrder.set(s.session_id, arrivals++);
  }
  for (const s of nested) {
    if (!nestedOrder.has(s.session_id)) nestedOrder.set(s.session_id, arrivals++);
  }

  const live = new Set(real.map((s) => s.session_id));
  for (const id of [...sessionOrder.keys()]) {
    if (!live.has(id)) sessionOrder.delete(id);
  }
  const liveNested = new Set(nested.map((s) => s.session_id));
  for (const id of [...nestedOrder.keys()]) {
    if (!liveNested.has(id)) nestedOrder.delete(id);
  }

  const ordered = [...real].sort(
    (a, b) =>
      folderOrder.get(folderKeyFor(a)) - folderOrder.get(folderKeyFor(b)) ||
      sessionOrder.get(a.session_id) - sessionOrder.get(b.session_id)
  );

  slots.fill(null);
  nestedBySlot.length = slots.length;
  nestedBySlot.fill(null);

  const visible = ordered.slice(0, slots.length);
  visible.forEach((s, i) => {
    slots[i] = s.session_id;
    // Only the first button of a project's contiguous block carries its
    // nested (worktree) sessions, so the indicator and double-press trigger
    // show in exactly one place per project. Nested sessions are sorted by
    // their own first-seen order (nestedOrder), not whatever order this
    // particular poll happened to report them in.
    const isPrimary = i === 0 || folderKeyFor(visible[i - 1]) !== folderKeyFor(s);
    const own = nestedFor(s, nested, isPrimary);
    if (isPrimary || own.length) {
      nestedBySlot[i] = own.sort((a, b) => nestedOrder.get(a.session_id) - nestedOrder.get(b.session_id));
    }
  });
}

/**
 * The nested sessions that belong on `session`'s key.
 *
 * An Agent-tool subagent knows the session that spawned it, so it lands on
 * that session's own key — a folder with three sessions open in it must not
 * green an idle key for an agent two keys over, which is exactly what
 * attaching by folder did. An SDK session has no parent key to land on (it's a
 * separate process nobody on the board owns), so it keeps the old behaviour
 * and falls back to the project's block; `primary` is what keeps that to one
 * key per project.
 */
export function nestedFor(session, nested, primary) {
  return nested.filter((n) =>
    n.parent ? n.parent === session.session_id : primary && folderKeyFor(n) === folderKeyFor(session)
  );
}

// The three things every board derives from a session the same way. One copy
// rather than one per view: the fallback chain and the clearedEmpty rule
// below are invariants (see CLAUDE.md), and the second copy had already
// dropped a field the first one drew.
//
// `projectPath` is the folder whose basename names the key — the matched VS
// Code window normally, but a worktree session's own cwd on the detail board,
// where the parent project's name is already on screen.
// The caps bar is always the project name — the matched window's folder, not
// the session's cwd. A worktree agent belongs to its project and says so;
// two agents in one repo read KOB-TRACE twice and are told apart by their
// body text, which is the thing that actually differs between them.
function keyFields(session) {
  return {
    // Prefer the AI-generated title (the exact string VS Code's terminal list
    // shows), then the last thing you typed, then Claude Code's short session
    // name, then the cwd's basename — each a fallback for when the one before
    // it isn't available yet or a future Claude Code version changes format.
    //
    // `lastPrompt` is the rung that matters early: aiTitle doesn't exist for
    // the first turn or two of a session, and the two rungs under it are a
    // placeholder Claude Code derived from the cwd (`kob-portal2-01`) and the
    // cwd itself — both of which say strictly less than the caps bar right
    // above them. What you asked for is the honest answer to "what is this
    // key", and it's read from the same tail scan aiTitle comes out of.
    //
    // Two ways to have nothing to say, and both skip that whole chain.
    // clearedEmpty: /clear reuses the transcript file, so a title found there
    // would be the pre-clear one. startedEmpty: the session is open but has
    // never been typed into. Either way name/cwd would look like a real
    // answer when the honest one is "nothing yet" — renderKey draws CLEAR.
    // Nothing below is allowed to fill that blank: a session that is *working*
    // must never read CLEAR, and one that has never been spoken to must.
    label: session.clearedEmpty || session.startedEmpty
      ? ""
      : session.aiTitle ??
        session.lastPrompt ??
        session.name ??
        session.cwd.split("/").filter(Boolean).pop() ??
        session.cwd,
    project: session.folder.split("/").filter(Boolean).pop() ?? "",
    // `ts` is 0 when the registry entry carried neither statusUpdatedAt nor
    // updatedAt; formatAge would otherwise report the age of the epoch.
    age: session.ts ? formatAge(Date.now() / 1000 - session.ts) : "",
  };
}

// The detail board, as data. Kept separate from drawing so the slot
// arithmetic — which is where an off-by-one silently hides a task — is
// testable without a Stream Deck.
//
// Worktree tiles are pinned to the tail rather than appended after the tasks:
// they're the only way to reach those sessions, and a twenty-task plan would
// otherwise push them off the board.
// Bottom-left key on an MK.2: keys are row-major across 5 columns, so row 2
// starts at 10. The detail board takes over the whole deck — usage and
// attention keys included — so it owes you an unambiguous way out.
export const DETAIL_BACK_INDEX = 10;

// The stats board's way in to the config page, beside the back key on the
// bottom-left row — the tile list reaches index 9, so 11 and 12 are the two
// buttons it never fills. Assigned by index rather than spliced, for the same
// reason the back key is: an unreadable stats cache makes the list short, and
// the way in must not move.
export const CONFIG_INDEX = 11;

// The stats board's last free slot. With this, all 13 are spoken for — an
// eighth stats tile would now land under the config key rather than merely
// under the back key.
export const BLOCKED_TODAY_INDEX = 12;

/**
 * Today's total time blocked on you, across every project, as a stat value.
 *
 * Read per stats-board poll rather than kept live: the board refreshes every
 * 2s and the file is a few hundred KB at most, against a 30-day cap. If that
 * stops being true it wants a cache, not a different source.
 */
function blockedToday() {
  const now = Date.now();
  const totals = summarise(readHistory(), now, startOfDay(now));
  const ms = Object.values(totals).reduce((sum, states) => sum + (states.requires_action ?? 0), 0);
  return ms < 60000 ? "0m" : formatAge(ms / 1000);
}

/**
 * Does this press mean "tell me more" about the session it lands on?
 *
 * The rule is: a press escalates to the detail board only when it **changed
 * nothing**. If it had to switch you to a different terminal, that was a first
 * press, however many presses came before it.
 *
 * This used to match on the *folder* rather than the session, and that was
 * right at the time: a press could only raise a window, so every key in a
 * project's contiguous block did the identical thing and moving along the block
 * was the same gesture as pressing one key twice. Terminal focus falsified the
 * premise — pressing key A and key B now reveal two different terminals — and
 * the symptom was that a project's second session could not be reached at all,
 * because its key opened the detail board instead of its terminal.
 *
 * "Changed nothing" isn't knowable from out here: it needs the window's focus
 * state and which terminal is in front, both of which live inside the editor.
 * `windows` is what the extension publishes for exactly this. Inferring it
 * instead ("you pressed this session last, so its terminal must still be
 * showing") is one line and wrong in the two cases you'd notice — after
 * alt-tabbing away, and after clicking another terminal by hand.
 *
 * **Degradation is per window, not per machine.** A window that publishes no
 * state is not running the extension, whatever is installed on disk — on
 * 2026-08-16 the extension was installed and zero open windows were running it,
 * because none had been reloaded, so an install check would have said yes and
 * been useless. Such a window keeps the old folder rule, so reloading one
 * window changes that window and no other.
 *
 * **Degradation is also per session, for the same reason.** A window
 * publishing state proves only that *some* session in its folder is
 * revealable — not this one. `claude` running in iTerm on a project that's
 * also open in VS Code still gets a board key (`sessions.mjs` joins on
 * folder, not on terminal) and its window will publish, but no terminal in it
 * will ever match; a `tmux` session or any reparented process breaks the pid
 * ancestry the extension walks the same way. Trusting the window's presence
 * for that session would make `matching.some(...)` false forever — and since
 * `previous?.session_id === press.session_id` alone can never open detail,
 * that session's board would be permanently unreachable, silently. Silence
 * only becomes proof after giving the extension a fair chance to answer: a
 * session asked for more than `REVEAL_GRACE_MS` ago and never once reported
 * active isn't "hasn't happened yet", so past that point the folder rule
 * takes back over for it, same as a window with no extension at all.
 */
// The extension ticks every 400ms; twice that is enough for a real reveal to
// have landed if one was ever going to, and short enough not to stall a
// session that could never be revealed in the first place.
const REVEAL_GRACE_MS = 1000;

export function isRepeatPress(previous, press, windows = [], capability = {}) {
  const { everActive = new Set(), requestedAt = new Map(), now = Date.now() } = capability;
  // An empty key can't start a chain (no session to tell you about) and,
  // having no folder, can't continue one.
  if (press.session_id === null || press.folder === null) return false;

  // Two hosts can publish the same folder — the same host-merge problem
  // `folderKeyFor` solves for the board applies here too, so a window is only
  // a candidate when it's on the press's own host. `w.host` can be undefined
  // on a window object built before this change, so it's normalised with
  // `?? null`; `press.host` is always set explicitly where the real press is
  // built (`deck.on("down")`), but `sameProject` below coalesces it too — a
  // future call site that forgets `host` must not silently turn a real repeat
  // into a false one, and the cost of the extra `?? null` is nothing.
  //
  // Exact match only — matchFolder also returns truthy for an *ancestor*
  // match (`nested: true`), which is a different, unrelated window whose
  // open folder merely contains this one. `press.folder` is by construction
  // one of a window's own published workspace-folder strings, so the right
  // window is always an exact match when it has published at all; falling
  // through to an ancestor match instead suppresses the folder rule for a
  // session whose own window was never reloaded, on the say-so of a sibling
  // window that was.
  const matching = windows.filter(
    (w) => (w.host ?? null) === press.host && matchFolder(press.folder, w.folders)?.nested === false
  );
  // Same path, same host — the fallback the folder rule reduces to whenever
  // there's no window to ask. Two hosts sharing a path must not pass this
  // just because the paths match.
  const sameProject = previous?.folder === press.folder && (previous?.host ?? null) === (press.host ?? null);
  // No extension in this session's window — today's rule, unchanged.
  if (matching.length === 0) return sameProject;

  // A remote press used to short-circuit to `sameProject` here, because a
  // remote window could never reveal a terminal and so could never report one
  // active — the extension's answer was a permanent "no" rather than "not yet",
  // and `askedLongAgo` could not arm because `focusWindow` returned before
  // `requestedAt` was set. That guard is gone with the thing that justified it:
  // a remote session is revealable now, so it takes the ordinary path below.
  //
  // Worth keeping the shape of that mistake in view. The guard read as correct
  // in isolation right up until a later change removed its precondition, which
  // is the same way the in-flight and eviction guards went wrong during the
  // first half of this feature. A guard that encodes "X is impossible" needs
  // deleting in the commit that makes X possible.

  // This session was asked for a while ago and no window has ever reported
  // it active: proof it can't be revealed through the extension (see the
  // docstring), so answer with the folder rule instead of a `.some()` that
  // can only ever be false for it.
  const askedLongAgo = requestedAt.has(press.session_id) && now - requestedAt.get(press.session_id) >= REVEAL_GRACE_MS;
  if (askedLongAgo && !everActive.has(press.session_id)) return sameProject;

  // Every candidate is asked, rather than one being elected with .find().
  // Two windows can have the same folder open — CLAUDE.md records exactly that
  // live on this machine — and electing one would answer from whichever
  // readdir returned first. Only the window that actually revealed the session
  // can report it active, so `.some` is self-disambiguating: it needs no way to
  // tell the windows apart, which is a problem this project has not solved.
  return (
    previous?.session_id === press.session_id &&
    matching.some((w) => w.focused && w.activeSessionId === press.session_id)
  );
}

export function detailLayout({ session, tasks, nested, age, slotCount }) {
  // Literally the session's own key — same label, same caps bar, clearedEmpty
  // rule included, so the key you pressed is the key you land on. It used to
  // be split across two keys; one says the same thing and leaves a slot for a
  // task.
  const { label, project } = keyFields(session);
  const header = [
    { kind: "label", label, project },
    { kind: "stat", label: "STATE", value: age ? `${session.state} ${age}` : session.state },
    // A ring when the number is known — `pie` is what renderStat draws, `value`
    // is the dash it falls back to when the status line never wrote a context
    // file for this session.
    {
      kind: "stat",
      label: "CONTEXT",
      value: typeof session.context === "number" ? `${session.context}%` : "—",
      pie: typeof session.context === "number" ? session.context : null,
    },
    {
      kind: "stat",
      label: "MODEL",
      // "claude-opus-5" is three quarters vendor on a 72px key.
      value: [(session.model ?? "").replace(/^claude-/, ""), session.effort ?? ""].filter(Boolean).join(" ") || "—",
    },
  ];

  // Subagents pin to the tail, ahead of the tasks: this board and a 3×6px
  // margin marker are the only places they appear at all, where a task list
  // past the window is merely truncated.
  const tail = nested.map((s) => ({ kind: "nested", session: s }));

  // Every slot except the back key is content; the back key is carved out
  // afterwards so the arithmetic here stays a simple "how many are left".
  const contentSlots = slotCount - 1;
  const tailTiles = tail.slice(0, Math.max(0, contentSlots - header.length));
  const taskRoom = contentSlots - header.length - tailTiles.length;
  const shown = taskWindow(tasks, taskRoom);
  const taskTiles = shown.map((t) => ({
    kind: "task",
    number: tasks.indexOf(t) + 1,
    subject: t.subject ?? "",
    status: t.status ?? "pending",
  }));

  const body = new Array(taskRoom).fill(null);
  taskTiles.forEach((tile, i) => (body[i] = tile));
  const tiles = [...header, ...body, ...tailTiles];
  // Splice the back key into its fixed position rather than reserving it up
  // front, so it lands on the same physical key no matter how the content
  // above it happens to fill.
  tiles.splice(DETAIL_BACK_INDEX, 0, { kind: "back" });
  return tiles;
}

// Holds the detail board's shape for a visit. `held` is the layout captured
// when the view opened, `fresh` this poll's; each held tile keeps its slot and
// re-reads its own content by identity — a task by its number, a worktree
// session by its id — so a task completing recolours a tile instead of sliding
// the board.
//
// A slot that was empty at open takes the fresh layout, *except* a worktree
// tile whose session is already held somewhere: detailLayout re-pins worktree
// tiles to the tail every poll, so a second one starting shifts the first one
// left, onto a slot that was empty at open — drawing that one session on two
// keys at once. Blanking that slot is the honest answer, and a new worktree
// session waiting until the board is reopened is the same fixed-order rule
// this whole function exists to enforce.
//
// Exported for slots-check: with the aliasing above invisible without a deck,
// this arithmetic has to be testable the same way detailLayout's is.
export function holdTiles(held, fresh, tasks, sessions) {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const pinned = new Set(held.filter((t) => t?.kind === "nested").map((t) => t.session.session_id));
  return held.map((tile, i) => {
    if (tile?.kind === "task") {
      const t = tasks[tile.number - 1];
      return t ? { ...tile, subject: t.subject ?? "", status: t.status ?? "pending" } : null;
    }
    if (tile?.kind === "nested") {
      const s = byId.get(tile.session.session_id);
      return s ? { kind: "nested", session: s } : null;
    }
    const f = fresh[i];
    return f?.kind === "nested" && pinned.has(f.session.session_id) ? null : f ?? null;
  });
}

// The bottom-right key is the usage readout rather than a session, so it is
// left out of `buttons` before slots are assigned.
async function drawUsage(deck, btn) {
  const { session, week } = await getUsage();
  const drawn = `usage ${session} ${week}`;
  if (btn.drawn === drawn) return;
  await deck.fillKeyBuffer(btn.index, await renderUsage({ ...btn, session, week }), { format: "rgba" });
  btn.drawn = drawn;
}

// Same drawn-signature diffing as every other key. Pulses with the board's
// requires_action keys when anything is blocked, so the two agree — see
// pulse() below, which reads renderParams cached here to redraw between
// polls without a fresh sessions read.
async function drawAttention(deck, btn, sessions, pulse) {
  const queue = attentionQueue(sessions, Date.now() / 1000);
  const longest = queue.length && queue[0].ts ? formatAge(Date.now() / 1000 - queue[0].ts) : "";
  // Cached every poll (not just on change), same convention refresh() uses
  // for session buttons, so pulse()'s faster tick has something to redraw
  // from without calling getLiveSessions() itself.
  btn.renderParams = { count: queue.length, longest };
  // Restart the 5s blink window whenever the queue grows — a new session
  // waiting is news, the same ones still waiting is not.
  if (queue.length > (btn.lastCount ?? 0)) btn.blinkUntil = Date.now() + ATTENTION_BLINK_MS;
  btn.lastCount = queue.length;
  const drawn = `attention ${queue.length} ${longest} ${pulse}`;
  if (btn.drawn !== drawn) {
    await deck.fillKeyBuffer(btn.index, await renderAttention({ ...btn, count: queue.length, longest, pulse }), {
      format: "rgba",
    });
    btn.drawn = drawn;
  }
  // Returned rather than re-derived by the press handler: a press needs to
  // know whether there's anything to open, and reading that back out of the
  // `drawn` signature string would couple key presses to a render-diffing
  // detail that changes the moment this key gains anything else to show.
  return queue.length;
}

// Stats view: the same 13 session buttons, repurposed as an all-time stats board.
// Reuses the `drawn`-signature diffing that `refresh` uses for sessions, so
// switching modes just redraws everything once (the signatures never match
// across modes) and needs no explicit invalidation.
async function refreshStats(deck, buttons, stats) {
  await Promise.all(
    buttons.map(async (btn, i) => {
      const stat = stats[i] ?? null;
      btn.assigned = null;
      btn.renderParams = null; // same as refreshDetail: keeps pulse off stale data

      if (!stat) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      // `stat` is already the one object rendered below — sign it directly
      // rather than hand-picking fields into a template string, same reason
      // as every other refresh*.
      const drawn = `stat ${JSON.stringify(stat)}`;
      if (btn.drawn === drawn) return;
      // Two tiles in the list aren't stats: the back key and the config key,
      // both assigned at fixed indices by the caller the same way the detail
      // board does it. They carry their own glyph/caps, which `...stat` hands
      // straight to renderBack — and which JSON.stringify(stat) above already
      // signs, so neither needs a branch of its own here.
      const render = stat.kind === "back" || stat.kind === "config" ? renderBack : renderStat;
      await deck.fillKeyBuffer(btn.index, await render({ ...btn, ...stat, big: true }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// The attention board: the queue across the session keys, re-ranked every
// poll. Unlike the detail view this deliberately re-sorts while it's up — a
// session that gets unblocked should leave the queue you're looking at.
async function refreshAttention(deck, buttons, attentionButton) {
  const sessions = await liveSessions();
  const queue = attentionQueue(sessions, Date.now() / 1000);
  const count = await drawAttention(deck, attentionButton, sessions, false);

  await Promise.all(
    buttons.map(async (btn, i) => {
      const session = queue[i] ?? null;
      btn.assigned = session;
      btn.renderParams = null; // see refreshDetail: keeps pulse off stale data

      if (!session) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      const { label, project } = keyFields(session);
      const accent = accentFor(folderKeyFor(session));

      // One object drives both the render call and the drawn signature (the
      // shape refreshDetail set and refresh() now also follows) so a field
      // drawn but not signed can't happen — that's what left this same
      // tile's gauge frozen once already, and dropped its task counter a
      // second time.
      const params = { state: session.state, label, accent, project, context: session.context, progress: session.progress };
      const drawn = `queue ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;
      const buf = await renderKey({ ...btn, ...params });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
  // Returned like drawAttention() so the poll loop can keep attentionCount
  // live from this branch too — this view's own call to drawAttention is
  // buried inside here rather than at the loop's call site.
  return count;
}

// Written from here rather than from assignSlots, which is exported and called
// by slots-check — a check that assigned an accent would write this machine's
// real file. The same reason keeps the config page's swap pure and over in
// accents.mjs: `applyAccentChoice` is exported and checked, this is neither.
// Only on change, which means the poll a new project first appears on plus
// every manual pick from that page; the map is otherwise the same every 2s.
// Synchronous
// because it is a few hundred bytes that rarely move; if this ever grows
// enough to be worth a frame, it is the wrong file.
let lastAccentsWritten = null;
function persistAccents() {
  const snapshot = JSON.stringify([[...folderAccent], projectOrder]);
  if (snapshot === lastAccentsWritten) return;
  lastAccentsWritten = snapshot;
  writeProjects(folderAccent, projectOrder);
}

// The config server's entire coupling to this daemon. Two functions, so the
// page can be rewritten — drag-to-reorder, when it lands — without touching
// anything here, and so config-check can drive the real server with fakes.
const configDeps = {
  projects: () =>
    [...liveProjects]
      .map(([key, p]) => ({ key, name: p.name, host: p.host, accent: accentFor(key) }))
      // ?? Infinity, not a bare subtraction: assignSlots is what fills
      // folderOrder and it runs only on sessions-board polls, so a project
      // that appeared while the stats board was up has no position yet.
      // undefined - undefined is NaN, and a comparator returning NaN sorts
      // arbitrarily rather than failing.
      .sort((a, b) => (folderOrder.get(a.key) ?? Infinity) - (folderOrder.get(b.key) ?? Infinity)),
  setAccent: (folder, accent) => {
    applyAccentChoice(folderAccent, new Set(liveProjects.keys()), folder, accent);
    // Immediately rather than on the next poll, so a pick survives a daemon
    // killed a second later. persistAccents' snapshot makes that poll's own
    // call a no-op.
    persistAccents();
  },
  reorder: (folder, before) => {
    moveProject(projectOrder, folder, before);
    reindexProjects();
    persistAccents();
  },
  // Formatted here rather than in the page: config-server.mjs owns markup and
  // nothing else, which is what lets config-check render the table from three
  // fixed strings instead of reconstructing a day of history.
  //
  // Every project the history knows, not just the live ones — the question is
  // where the week went, and a project you closed an hour ago is exactly the
  // kind of answer that would go missing. Ordered by today's blocked time,
  // because that is the column the page exists for.
  history: () => {
    const now = Date.now();
    const records = readHistory();
    const today = summarise(records, now, startOfDay(now));
    const week = summarise(records, now, now - 7 * 86400000);
    const dur = (ms) => (!ms || ms < 60000 ? "—" : formatAge(ms / 1000));
    const cell = (states = {}) => ({
      busy: dur((states.busy ?? 0) + (states.shell ?? 0)),
      waiting: dur(states.waiting),
      blocked: dur(states.requires_action),
    });
    return [...new Set([...Object.keys(today), ...Object.keys(week)])]
      .filter(Boolean)
      .map((key) => ({
        key,
        name: liveProjects.get(key)?.name ?? key.split("/").filter(Boolean).pop() ?? key,
        today: cell(today[key]),
        week: cell(week[key]),
        blockedMs: today[key]?.requires_action ?? 0,
      }))
      .sort((a, b) => b.blockedMs - a.blockedMs);
  },
};

/**
 * One stand-in "session" per folder whose keys are missing because its host is
 * unreachable, so the block says so instead of quietly going short.
 *
 * These are synthesised here and **nowhere else** — deliberately not in
 * `liveSessions()`. They must not reach `publishSessions` (the restore command
 * would try to `claude --resume` an id nothing can resume), `liveProjects` (the
 * config page would list a project that isn't running), or `attentionQueue`
 * (nothing here is blocked on you). `refresh` is the only consumer that needs
 * them, so it is the only place they exist.
 *
 * They carry the real folder and host, which is what earns them the block's
 * own slot and accent: `folderKeyFor` and `folderOrder` treat them exactly as
 * the missing sessions were treated, so the key appears where it always was.
 */
function unreachableTiles(windows) {
  return unreachableHosts(windows, remoteMemo).map(({ host, folder, since }) => ({
    session_id: `unreachable:${host}:${folder}`,
    folder,
    host,
    // Grey, not red: nothing here is blocked on you, and CLAUDE.md reserves the
    // pulse for that. The word on the key is what disambiguates this from an
    // idle session, since the colour can't.
    state: "idle",
    nested: false,
    unreachable: true,
    ts: since / 1000,
  }));
}

async function refresh(deck, buttons, slots, nestedBySlot) {
  const sessions = await liveSessions();
  const tiles = [...sessions, ...unreachableTiles(readWindowStates())];
  assignSlots(tiles, slots, nestedBySlot);
  persistAccents();
  const byId = new Map(tiles.map((s) => [s.session_id, s]));

  await Promise.all(
    buttons.map(async (btn, slot) => {
      const session = slots[slot] ? byId.get(slots[slot]) : null;
      btn.assigned = session ?? null;
      btn.nestedSessions = nestedBySlot[slot] ?? [];

      if (!session) {
        btn.renderParams = null;
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      // A stand-in for a block whose host can't be reached. Handled before
      // keyFields, which reads fields only a real session has — and drawn from
      // the same renderKey with the same accent, so the block keeps its
      // identity while it says what happened to it. No renderParams: pulse()
      // has nothing to animate here, and leaving stale ones would let it
      // redraw a key this branch owns.
      if (session.unreachable) {
        btn.renderParams = null;
        const params = {
          state: "idle",
          // "offline", not the accurate "unreachable": renderKey fills lines
          // by character, so an eleven-letter word breaks mid-word and the key
          // read "pi unreac / hable 4m" — checked on the raster, not guessed.
          // "pi offline" / "4m" wraps at the space at every duration. The
          // stderr line keeps the precise word; a key across a room does not
          // get to spend eleven characters distinguishing "host down" from
          // "ssh down" when the thing you do about it is the same.
          //
          // The duration rides in the label because renderKey has no age slot:
          // that sits on the accent bar and is fed by keyFields, which this
          // branch skips.
          label: `${session.host} offline ${formatAge(Date.now() / 1000 - session.ts)}`,
          accent: accentFor(folderKeyFor(session)),
          project: session.folder.split("/").filter(Boolean).pop() ?? "",
        };
        const drawn = `unreachable ${JSON.stringify(params)}`;
        if (btn.drawn === drawn) return;
        await deck.fillKeyBuffer(btn.index, await renderKey({ ...btn, ...params }), { format: "rgba" });
        btn.drawn = drawn;
        return;
      }
      const { label, project } = keyFields(session);
      const accent = accentFor(folderKeyFor(session));
      const nestedStates = btn.nestedSessions.map((n) => n.state);
      // The key stands for its whole project block, so its colour takes the
      // most urgent state in it: a session working only through a worktree
      // subsession reads as working, rather than sitting grey behind a margin
      // marker. Those subsessions have no key of their own, so this is the
      // only place their state can reach a whole key.
      //
      // Colour only. The title, gauge and counter still describe this key's
      // own session — they are the fields a subsession can't speak for.
      const state = mostUrgent([session.state, ...nestedStates]);
      // One object drives both the render call and the drawn signature — the
      // shape refreshDetail set and the other refresh* functions now also
      // follow — so a field rendered but not signed can't happen. Cached on
      // the button every poll (not just on change) so the pulse loop below
      // can redraw a requires_action key between polls without re-deriving it
      // from a fresh getLiveSessions() call.
      // `shell` is carried separately because `state` is now the block's, and
      // the margin's blue dot is about this session alone — without it, a key
      // going green for a busy subsession would erase its own shell marker.
      const params = { state, shell: session.state === "shell", label, accent, project, progress: session.progress, context: session.context, nestedStates };
      btn.renderParams = params;

      // Skip the re-encode when nothing visible changed — most polls are
      // no-ops once a board has settled.
      // A compacting key is its own renderer, not a colour: it's the one
      // state where the useful thing to show is "still going, leave it" rather
      // than a title and a gauge. The signature omits the phase so the 2s poll
      // doesn't fight the 400ms sweep for the key — pulse() owns the animation
      // and, as everywhere else here, never writes btn.drawn.
      const drawn = `session ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;
      const buf =
        state === "compacting"
          ? await renderCompacting({ ...btn, accent, project, phase: 0 })
          : await renderKey({ ...btn, ...params });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
  return sessions;
}

// The detail board: one session across every session key — its own key redrawn,
// three stat tiles, then its task list, with the worktree sessions that share
// its folder held at the tail. This is where those sessions became reachable
// as tiles instead of 3×6px squares, which is why the old nested-only overlay
// is gone.
//
// Content refreshes every poll; the shape does not. `view.tiles` is captured
// on the first poll after the view opens and then held, so a task completing
// recolours its tile rather than sliding the whole window (taskWindow
// re-centres on the in-progress task) under your finger. Tasks are read here
// rather than in getLiveSessions so the 2s poll costs exactly what it did
// before this view existed.
async function refreshDetail(deck, buttons, view) {
  const sessions = await liveSessions();
  const session = sessions.find((s) => s.session_id === view.session_id);
  if (!session) {
    // It ended while you were looking at it. Stale-but-plausible tiles (a
    // busy STATE tile whose age has stopped advancing, tasks for a session
    // that no longer exists) are worse than blank, so every tile is blanked
    // here rather than left however it last drew — and renderParams is
    // nulled the same as the found-session path below, so pulse() doesn't
    // repaint this frame the instant the poll loop drops back to the
    // sessions board.
    await Promise.all(
      buttons.map(async (btn) => {
        btn.assigned = null;
        btn.renderParams = null;
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
      })
    );
    return null; // tells the poll loop there's nothing left to show
  }

  // The subagents this session has running, plus the project's sdk sessions,
  // which never hold a board key of their own — this board and the margin
  // markers are the only places they appear at all. Same rule as the margin
  // markers (`nestedFor`), so a tile and a marker can't disagree about whose
  // agent it is; `primary` is true because a detail board is the one place
  // per project you can be looking at. They're short-lived, so one may well
  // vanish between two polls.
  const nested = nestedFor(session, sessions.filter((s) => s.nested), true);
  const tasks = await readTaskList(session.session_id, session.root);
  const { age } = keyFields(session);
  const fresh = detailLayout({ session, tasks, nested, age, slotCount: buttons.length });
  view.tiles ??= fresh;
  const tiles = holdTiles(view.tiles, fresh, tasks, sessions);
  const accent = accentFor(folderKeyFor(session));

  await Promise.all(
    buttons.map(async (btn, i) => {
      const tile = tiles[i];
      btn.assigned = null; // detail tiles have no window of their own to focus
      // pulse() is paused while this view shows (run() freezes it on
      // view.kind), but the instant it's dismissed pulse resumes on its own
      // 400ms tick and reads whatever btn.renderParams already holds — which,
      // without this, would still be each button's pre-detail data, stale by
      // however long the view was open. Nulling it means pulse finds nothing
      // to redraw until the next refresh() repopulates it, at most 2s later.
      btn.renderParams = null;

      if (!tile) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }

      // The render call takes exactly these params and the diff signature is
      // built from exactly these params, so no drawn field can go missing
      // from it — that omission (accent and context, on the queue tiles) is
      // what froze a gauge for minutes.
      const params =
        tile.kind === "back"
          ? {}
          : tile.kind === "task"
          ? { number: tile.number, subject: tile.subject, status: tile.status }
          : tile.kind === "stat"
          ? { label: tile.label, value: tile.value, pie: tile.pie ?? null }
          : tile.kind === "nested"
          ? {
              state: tile.session.state,
              accent,
              ...keyFields(tile.session),
              progress: tile.session.progress,
              context: tile.session.context,
            }
          : { state: session.state, label: tile.label, accent, project: tile.project };
      const drawn = `detail ${tile.kind} ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;

      const render =
        tile.kind === "back" ? renderBack : tile.kind === "task" ? renderTask : tile.kind === "stat" ? renderStat : renderKey;
      await deck.fillKeyBuffer(btn.index, await render({ ...btn, ...params }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
  // Returned so the poll loop can hand the same read to drawAttention rather
  // than calling getLiveSessions() a second time for the same 2s tick.
  return sessions;
}

// Flashes every requires_action key from its dark-gold background up to
// bright gold for one tick every REQUIRES_ACTION_FLASH_MS — the one state
// that's actually blocked on you, so the one worth catching your eye, but a
// blip rather than a steady alternation so a board with one blocked session
// doesn't read as though something's actively wrong the whole time. The
// attention key blinks on the plain PULSE_MS tick instead, and only when
// its cached count is nonzero — a CLEAR key stays dark and still. Runs on
// its own faster tick alongside the main poll rather than inside it:
// `refresh` only redraws on change, but a pulse must redraw on a fixed beat
// regardless. `btn.drawn` is left alone so the next `refresh`/`drawAttention`
// still recognises a steady frame as unchanged.
async function pulse(deck, buttons, attentionButton, isOverlayView, isDisconnected) {
  let bright = false;
  let tick = 0;
  while (!isDisconnected()) {
    bright = !bright;
    tick++;
    // Bright for the first PULSE_MS of every REQUIRES_ACTION_FLASH_MS window,
    // dark gold the rest — a blip on the wall clock, not a tick-counter
    // alternation.
    const actionBright = Date.now() % REQUIRES_ACTION_FLASH_MS < PULSE_MS;
    if (!isOverlayView()) {
      try {
        await Promise.all([
          ...buttons
            .filter(
              (btn) =>
                btn.renderParams?.state === "requires_action" ||
                btn.renderParams?.state === "compacting" ||
                (btn.renderParams?.nestedStates?.length ?? 0) > 0 ||
                btn.renderParams?.context >= CONTEXT_CRITICAL
            )
            .map(async (btn) => {
              // The sweep advances a twelfth per 400ms tick — a full turn every
              // ~5s, slow enough to read as deliberate against a compaction
              // that runs a minute or two. The red gauge flips red/white every
              // other tick, i.e. about once a second — close to but off the
              // requires_action beat, so the two don't read as the same
              // alarm, but a hard flip rather than anything gradual. Two slow
              // fades shipped before it (a pink one, then a white one) and
              // neither was visible on the deck — 2px of line is too little
              // to carry a gradient.
              const buf =
                btn.renderParams.state === "compacting"
                  ? await renderCompacting({ ...btn, ...btn.renderParams, phase: (tick % 12) / 12 })
                  : await renderKey({ ...btn, ...btn.renderParams, pulse: actionBright, contextPhase: (tick % 4) / 4 });
              await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
            }),
          ...(() => {
            // Blink only inside the 5s window drawAttention opened; after it
            // closes, write exactly one steady frame — pulse never touches
            // btn.drawn, so without that settle write the key could freeze on
            // whatever bright frame the last in-window tick left behind.
            const params = attentionButton.renderParams;
            const blinking = params?.count > 0 && Date.now() < (attentionButton.blinkUntil ?? 0);
            if (!params || (!blinking && !attentionButton.blinkSettle)) return [];
            attentionButton.blinkSettle = blinking;
            return [
              (async () => {
                const buf = await renderAttention({ ...attentionButton, ...params, pulse: blinking && bright });
                await deck.fillKeyBuffer(attentionButton.index, buf, { format: "rgba" });
              })(),
            ];
          })(),
        ]);
      } catch (err) {
        console.error("pulse failed:", err.message);
      }
    }
    await new Promise((r) => setTimeout(r, PULSE_MS));
  }
}

// The deck currently being driven, so a signal handler can wipe it on the way
// out. Nothing else may reach for this — every draw path is handed its deck.
let activeDeck = null;

async function run() {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new Error("No Stream Deck found. Is it plugged in?");
  }
  const deck = await openStreamDeck(devices[0].path);
  activeDeck = deck;
  // Read here rather than at module scope: importing this file must not touch
  // the real ~/.claude, or every check inherits this machine's live palette.
  const remembered = readProjects();
  loadAccents(remembered.accents, remembered.order);
  // Which build is driving the deck — worth stating, since a worktree and the
  // main checkout can each be started against the same device.
  console.log(`claude-streamdeck v${pkg.version} — connected to ${deck.PRODUCT_NAME}`);

  const allButtons = deck.CONTROLS.filter((c) => c.type === "button")
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      index: c.index,
      width: c.pixelSize.width,
      height: c.pixelSize.height,
      assigned: null,
      drawn: null,
    }));
  // Keys are row-major, so the highest index is the bottom-right one, and the
  // one before it is bottom-row-second-from-right. Both are reserved, leaving
  // 13 session slots.
  const usageButton = allButtons.pop();
  const attentionButton = allButtons.pop();
  // The detail board takes over the entire deck, usage and attention keys
  // included, so it needs the full list — every other board draws only the
  // session keys.
  const allKeys = [...allButtons, attentionButton, usageButton].sort((a, b) => a.index - b.index);
  const buttons = allButtons;
  const slots = new Array(buttons.length).fill(null);
  const nestedBySlot = new Array(buttons.length).fill(null);

  let disconnected = false;
  // Which board is showing. One value rather than a flag per view: with four
  // of them, "stats and detail are both somehow on" is a state that shouldn't
  // be representable.
  //   { kind: "sessions" }
  //   { kind: "stats" }
  //   { kind: "attention" }
  //   { kind: "detail", session_id, tiles }
  // `tiles` is filled in by the first refreshDetail after the view opens and
  // then held, so the board's shape stays put while its content updates.
  let view = { kind: "sessions" };
  // Latest attentionQueue length, kept here so the press handler can read it
  // without a second query — drawAttention returns it on every call, this
  // just holds the most recent value.
  let attentionCount = 0;
  // The immediately preceding key-down, updated on every press regardless of
  // what it did — this is what makes a second press within one project mean
  // "again", and any key outside it break that chain.
  let lastPress = null;
  // Sessions some window has ever reported as its `activeSessionId`, and when
  // `focusWindow` last fired a reveal request for a session — together, what
  // `isRepeatPress` needs to tell "not revealed yet" from "can never be
  // revealed" (see its docstring). Both reset per daemon run, same as
  // `lastPress`: a session's revealability isn't known in advance, and
  // yesterday's answer for a pid that's since been reused would be worse than
  // no answer at all.
  const everActive = new Set();
  const requestedAt = new Map();
  // Last logged "N of M windows have the extension", so the line is printed
  // when it changes rather than every 2s. Logged on change and not only at
  // startup because the number changes as you reload windows, and that is
  // exactly the moment the feedback is worth having — a startup-only message
  // would need a daemon restart to tell you the reload worked.
  let lastCoverage = null;
  // Every view change goes through here so the attention key can't stick on
  // a bright pulse frame: pulse() writes without touching btn.drawn, so if the
  // view flips away from "sessions" mid-pulse the attention key can freeze on
  // whichever frame it was mid-write, and its own signature never changes to
  // force a repaint. Nulling attentionButton.drawn on every transition costs
  // one redundant redraw at worst and guarantees the next drawAttention call
  // repaints it for real.
  // It also clears the press chain, which matters for the transitions the poll
  // loop makes on its own: a detail board whose session ends drops you back to
  // the sessions board still holding the press that opened it, and the next
  // press on that project would reopen the board you were just thrown out of.
  // Presses that do want to seed a chain set `lastPress` after calling this.
  const setView = (next) => {
    view = next;
    attentionButton.drawn = null;
    lastPress = null;
  };
  deck.on("error", (err) => {
    console.error("Stream Deck error:", err);
    disconnected = true;
  });
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const isUsage = control.index === usageButton.index;
    const isAttention = control.index === attentionButton.index;
    const btn = isUsage || isAttention ? null : buttons[control.index];
    const sessionId = btn?.assigned?.session_id ?? null;
    const folder = btn?.assigned?.folder ?? null;
    const host = btn?.assigned?.host ?? null;
    const press = { index: control.index, session_id: sessionId, folder, host };

    // The detail board owns the whole deck, so it leaves only by its own back
    // key. Every other key there is a tile describing something — pressing a
    // task or a subagent shouldn't throw the board away, and the back key is
    // right there saying so.
    if (view.kind === "detail") {
      if (control.index === DETAIL_BACK_INDEX) setView({ kind: "sessions" });
      // Nothing here seeds a repeat: the tiles aren't session keys, and the
      // back key may still be sitting on a session whose project matches the
      // one you press next — which would reopen the board you just left.
      // `refreshDetail` nulls every `assigned` on its first poll, but that's
      // up to 2s away, and the outcome must not depend on how fast you press.
      lastPress = null;
      return;
    }
    // The queue is the opposite: it's transient triage, so any press leaves.
    if (view.kind === "attention") {
      setView({ kind: "sessions" });
      // A session key still focuses its window on the way out — that's the
      // whole point of pressing one there.
      if (btn?.assigned) focusWindow(btn.assigned, requestedAt);
      lastPress = press;
      return;
    }
    if (isUsage) {
      setView(view.kind === "stats" ? { kind: "sessions" } : { kind: "stats" });
      return;
    }
    if (isAttention) {
      // Dark key, nothing queued: a press has nothing to show, so it does
      // nothing rather than opening an empty board. `attentionCount` is what
      // the last drawAttention() returned.
      if (attentionCount > 0) setView({ kind: "attention" });
      // Pressed while dark it changes no view, so it clears the chain itself:
      // a key that does nothing must still count as "something else in between".
      lastPress = null;
      return;
    }
    if (view.kind === "stats") {
      // Stat tiles aren't clickable; the back key and the config key are.
      // (The usage key still toggles the board off, handled above.)
      if (control.index === DETAIL_BACK_INDEX) setView({ kind: "sessions" });
      if (control.index === CONFIG_INDEX) {
        // Not awaited, and it cannot throw: a press is a synchronous handler,
        // and openConfig swallows everything the way every other risky path
        // here does.
        void openConfig(configDeps);
        // Back to the sessions board on the way out. The browser takes focus
        // anyway, and watching the accents change on the real keys is the only
        // place the choice actually reads.
        setView({ kind: "sessions" });
      }
      lastPress = null;
      return;
    }

    // Read per press, not cached on the poll: which terminal is in front can
    // change between two presses, and a 2s-stale answer is exactly the wrong
    // one when the question is "did anything just change".
    const isRepeat = isRepeatPress(lastPress, press, readWindowStates(), { everActive, requestedAt });
    // Both presses focus the window: between the two you may well have
    // alt-tabbed somewhere else, and a press that opens the detail board but
    // leaves you looking at Safari has done half its job.
    if (btn?.assigned) focusWindow(btn.assigned, requestedAt);
    // setView cleared the chain, so the press that opened detail can't also
    // seed the next one — see the detail branch above for the other half.
    if (isRepeat) setView({ kind: "detail", session_id: sessionId });
    else lastPress = press;
  });

  // Runs alongside the poll loop below, not inside it — it needs a much
  // faster beat than the 2s poll to read as a pulse.
  pulse(deck, buttons, attentionButton, () => view.kind !== "sessions", () => disconnected);

  while (!disconnected) {
    try {
      if (view.kind === "stats") {
        // Top-left pair: time left in each rate-limit window, ahead of the
        // all-time totals — these change by the hour/day, the totals barely
        // move. Session in hours (it resets within a day), week in days.
        const { sessionResetsAt, weekResetsAt } = await getUsage();
        const sessionHours = hoursUntil(sessionResetsAt);
        const weekDays = daysUntil(weekResetsAt);
        const resetTiles = [
          { label: "Session reset", value: sessionHours === null ? "—" : `${sessionHours}h` },
          { label: "Week reset", value: weekDays === null ? "—" : `${weekDays}d` },
        ];
        const versionTile = { label: "Version", value: pkg.version };
        const statTiles = [...resetTiles, ...(await getStats()), versionTile];
        // Same fixed slot as the detail board's back key, and assigned by
        // index rather than spliced: with an unreadable stats cache the list
        // is short, and the way out must still be on the bottom-left button.
        statTiles[DETAIL_BACK_INDEX] = { kind: "back" };
        statTiles[CONFIG_INDEX] = { kind: "config", glyph: "⚙", caps: "CONFIG" };
        // The last free slot. Today's blocked total is the one history number
        // worth a glance — the rest is a table, and a table belongs on the
        // config page.
        statTiles[BLOCKED_TODAY_INDEX] = { label: "Blocked today", value: blockedToday() };
        await refreshStats(deck, buttons, statTiles);
        attentionCount = await drawAttention(deck, attentionButton, await liveSessions(), false);
      } else if (view.kind === "attention") {
        attentionCount = await refreshAttention(deck, buttons, attentionButton);
        // The queue re-sorts while it's up so an unblocked session leaves it;
        // when the last one clears, you should leave too — otherwise a
        // drained queue is thirteen dark keys plus a dim CLEAR key,
        // indistinguishable at a glance from the daemon having died.
        //
        // Guarded on view.kind still being "attention": refreshAttention just
        // awaited a live getLiveSessions() call, and a press during that
        // await can already have moved the view elsewhere (including back
        // into "attention") — this must only ever close the board it just
        // drew, never a view a press has since chosen.
        if (attentionCount === 0 && view.kind === "attention") {
          setView({ kind: "sessions" });
          // Draw the board landed on in the same tick — refreshAttention just
          // blanked every key, and waiting for the next 2s poll to repaint
          // them is the same "looks dead" problem this exit exists to fix,
          // just shorter. refresh() already calls getLiveSessions() once;
          // reuse its return rather than querying again.
          const sessions = await refresh(deck, buttons, slots, nestedBySlot);
          attentionCount = await drawAttention(deck, attentionButton, sessions, false);
        }
      } else if (view.kind === "detail") {
        const detailSessions = await refreshDetail(deck, allKeys, view);
        // Same race guard as the attention branch above: only leave the
        // board this tick was actually drawing.
        if (detailSessions === null && view.kind === "detail") {
          // The session ended mid-visit; refreshDetail already blanked every
          // tile and nulled renderParams. Leave the board rather than sit on
          // it forever, repainting the same tick for the same reason.
          setView({ kind: "sessions" });
          const sessions = await refresh(deck, buttons, slots, nestedBySlot);
          attentionCount = await drawAttention(deck, attentionButton, sessions, false);
        }
        // No drawAttention here, and no drawUsage below: the detail board owns
        // all 15 keys, so anything else painting keys 13 and 14 fights it for
        // them and both flip back and forth on every poll. `attentionCount`
        // going stale while the board is up is harmless — the only press it
        // gates is on the attention key, which is a detail tile right now.
      } else {
        const sessions = await refresh(deck, buttons, slots, nestedBySlot);
        attentionCount = await drawAttention(deck, attentionButton, sessions, false);
        // One read serves both: the coverage log below, and `everActive` —
        // `isRepeatPress` needs a session ever reported active by *some* poll,
        // not just this one, so it's accumulated rather than replaced.
        const windowStates = readWindowStates();
        for (const w of windowStates) {
          if (w.activeSessionId) everActive.add(w.activeSessionId);
        }
        const withExt = windowStates.length;
        const total = countVsCodeWindows(undefined, windowStates);
        const coverage = `${withExt}/${total}`;
        if (coverage !== lastCoverage) {
          lastCoverage = coverage;
          console.log(
            // >=, not ===: `total` only counts windows running the Claude Code
            // extension (the IDE locks), `withExt` counts windows running
            // *this* extension. A window with Claude Code disabled but this
            // extension still active makes withExt > total, and `===` would
            // then take the reload-the-rest branch forever, on a machine
            // that's already fully covered.
            withExt >= total
              ? `vscode terminal focus: ${coverage} windows have the extension`
              : `vscode terminal focus: ${coverage} windows have the extension — reload the rest (Developer: Reload Window)`
          );
        }
      }
      if (view.kind !== "detail") await drawUsage(deck, usageButton);
    } catch (err) {
      console.error("refresh failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  activeDeck = null;
  await deck.close().catch(() => {});
}

/**
 * A stopped daemon must not leave a live-looking board. The hardware keeps the
 * last frame written to it forever, so without this Ctrl+C leaves the deck
 * showing sessions, colours and task counters from whenever it died — which is
 * exactly what a working board looks like. Same reasoning as the attention
 * queue leaving when it empties: nothing may look alive after it isn't.
 */
async function shutdown() {
  await activeDeck?.clearPanel().catch(() => {});
  process.exit(0);
}

async function main() {
  let connectedOnce = false;
  for (;;) {
    try {
      await run();
      connectedOnce = true;
    } catch (err) {
      console.error(err.message);
      if (!connectedOnce) {
        // Not found at startup: fail fast so the user can plug it in and rerun,
        // rather than silently retrying forever.
        process.exit(1);
      }
    }
    console.log(`Reconnecting in ${RECONNECT_MS / 1000}s...`);
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
  }
}

// Only run the daemon when executed directly, so checks can import from here.
// The signal handlers go inside the guard for the same reason: importing this
// module must not install any.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  main();
}
