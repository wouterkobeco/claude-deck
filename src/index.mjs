import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import qrcode from "qrcode-terminal";
import { getLiveSessions, localSource, matchFolder, readTaskList, taskWindow } from "./sessions.mjs";
import { fetchSource } from "./remote-fs.mjs";
import { cachedSources, remoteSources, unreachableHosts } from "./remote-hosts.mjs";
import { openFileIn } from "./vscode-state.mjs";
import { requestFocus } from "./terminal-focus.mjs";
import { publishSessions } from "./publish-sessions.mjs";
import { lanAddress, openConfig, startServer } from "./config-server.mjs";
import { memorySeries, memoryHosts, concurrency, readHistory, recordStates, recordTick, startOfDay, summarise, trimHistory, TICK_MS } from "./history.mjs";
import { collectTokens, compactTokens, earliestBucket, groupTokens, HOUR_MS, readTokens, summariseTokens } from "./tokens.mjs";
import { ACCENTS, applyAccentChoice, applyRename, moveProject, readProjects, writeProjects } from "./accents.mjs";
import { countVsCodeWindows, readWindowStates, staleWindows } from "./window-state.mjs";
import { renderKey, renderBlank, renderUsage, renderStat, renderAttention, renderFree, renderTask, renderBack, renderCompacting, formatAge, taskSquares, CONTEXT_CRITICAL } from "./render.mjs";
import { getUsage, formatReset, getAccountName } from "./usage.mjs";
import { getStats } from "./stats.mjs";
import { getCswapAccounts, withLiveUsage } from "./cswap.mjs";
import { getMemory, pctWithAmount } from "./memory.mjs";

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

// Each reachable host's memory, off the source its last fetch produced — the
// same place `ppids` is read from. Absent for a host that is failing or that
// has no /proc/meminfo; present means the numbers are at most one remote poll
// old, which is the staleness every other remote fact on the board carries.
// Each reachable host's fetched `ide/`, for the extension-coverage check: the
// tree fetch tars that directory, so a remote window's lock is as readable
// here as a local one, and "reload that window" can name remote ones too.
function remoteIdeDirs() {
  const out = [];
  for (const [host, entry] of remoteMemo) if (entry.source?.root) out.push({ host, dir: join(entry.source.root, "ide") });
  return out;
}

function hostMemories() {
  const out = {};
  for (const [host, entry] of remoteMemo) if (entry.source?.memory) out[host] = entry.source.memory;
  return out;
}

// Every machine's pressure, this one first, for whichever key or page wants
// the worst of them — `null` is the local host's name here as everywhere.
function allPressures() {
  const local = getMemory();
  return [{ host: null, pressure: local.pressure }, ...Object.entries(hostMemories()).map(([host, m]) => ({ host, pressure: m.pressure }))];
}
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
      liveProjects.set(key, { name: folderNames.get(key) ?? s.folder.split("/").filter(Boolean).pop() ?? "", host: s.host ?? null });
    }
  }
  // Not awaited: the file is for a window that has not restarted yet, so it is
  // never worth a frame. void-and-catch for the same reason as above — an
  // unwatched rejection would take the daemon down, and this one can only be a
  // filesystem that isn't answering.
  void publishSessions(sessions).catch(() => {});
  recordHistory(sessions);
  // Held for the board page, which is read by an iPad on its own 2s clock and
  // must not start a second pass over ~/.claude every time it asks. Every
  // board's poll goes through here, so this is at most one tick stale
  // whichever one is up — the same freshness the deck itself is drawing from.
  lastSessions = sessions;
  return sessions;
}

let lastSessions = [];

// State-history capture, hung off the one session read so it happens on every
// poll rather than on the polls of whichever board is up — the same reasoning
// publishSessions is here for. Only writes when something changed.
const lastStates = new Map();
let historyDay = 0;
let lastTick = 0;
let collecting = false;
function recordHistory(sessions) {
  const now = Date.now();
  recordStates(sessions, lastStates, now);
  // Coverage, not state: this is what lets the activity page tell a machine
  // that was asleep from one that was merely quiet. Both produce no change
  // records at all, and without a tick the chart reads five idle sessions
  // overnight as a working night. See history.mjs's TICK.
  if (now - lastTick >= TICK_MS) {
    lastTick = now;
    recordTick(now, undefined, getMemory(), hostMemories());
    collectTokensInBackground();
  }
  // Trimming is a whole-file rewrite, so it runs at startup (historyDay starts
  // at 0) and then once per local day — not on a timer, and never on a poll
  // that isn't already crossing a boundary the summary computes anyway.
  const today = startOfDay(now);
  if (today !== historyDay) {
    historyDay = today;
    const dropped = trimHistory(now);
    if (dropped) console.error(`history: dropped ${dropped} records past the retention window`);
    const merged = compactTokens(now);
    if (merged) console.error(`tokens: merged ${merged} duplicate hour buckets`);
  }
}

// Token capture, on the same tick as the coverage record and for the same
// reason it is not on the poll: this reads every transcript that has grown
// since last time, which on a first run means every byte of a 2GB tree — 11s,
// measured. Never awaited by the poll loop, and guarded so a slow pass cannot
// have a second one started on top of it against the same bookmark file. Same
// shape as remote-hosts.mjs's in-flight claim, and load-bearing for the same
// reason: the bookmark is written when a pass *finishes*.
function collectTokensInBackground() {
  if (collecting) return;
  collecting = true;
  collectTokens()
    .catch((err) => console.error("tokens:", err?.message ?? err))
    .finally(() => {
      collecting = false;
    });
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
// A folder's custom display name, when one has been set from the config
// page — read by keyFields (the deck's caps bar) and liveProjects (the config
// page's own list and the activity page's project table), so a rename reaches
// every place a project's name is shown from the one map.
const folderNames = new Map();
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
export function loadAccents(entries, order = [], names = []) {
  for (const [folder, accent] of entries) folderAccent.set(folder, accent);
  for (const [folder, name] of names) folderNames.set(folder, name);
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

// The mirror of the attention queue, and the other half of what the board is
// actually read for. `attentionQueue` answers "who needs me"; this answers
// "where can I put the next thing" — the question a deck full of idle keys is
// being scanned for, and the one that had no complete answer anywhere once
// there were more sessions than slots.
//
// **Free is the folded state, not the session's own.** `refresh` colours a key
// `mostUrgent([own, ...nested])`, so a session whose Agent-tool subagent is
// still running reads busy on the board; if this queue asked `s.state` alone
// it would offer you that session as free and contradict the key beside it.
// `shell` is likewise not free — a background shell it started is still going.
//
// Ranked by activity like the attention queue, and allowed to be for the same
// reason: transient triage you read, act on, and leave. Longest-idle first,
// because a session that finished twenty minutes ago is more obviously spare
// capacity than one that stopped ten seconds ago and may be mid-thought.
export function freeQueue(sessions, nowSeconds) {
  const nested = sessions.filter((s) => s.nested);
  return sessions
    .filter((s) => !s.nested && mostUrgent([s.state, ...nestedFor(s, nested, true).map((n) => n.state)]) === "idle")
    .sort((a, b) => (a.ts || nowSeconds) - (b.ts || nowSeconds) || a.session_id.localeCompare(b.session_id));
}

// The status key's third leg, reached by continuing past free rather than
// picked from the fold like attention/free are: sessions actually at work,
// not blocked and not idle. Same fold as freeQueue (own state plus its
// nested subagents' most urgent) for the same reason — a session whose
// subagent is still running must not read free here just because its own
// state is idle, and the mirror of that holds for busy.
// Longest-busy first: the one that's been at it the longest is the one most
// likely to have been forgotten about, same instinct as free's longest-idle.
export function busyQueue(sessions, nowSeconds) {
  const nested = sessions.filter((s) => s.nested);
  return sessions
    .filter((s) => !s.nested && mostUrgent([s.state, ...nestedFor(s, nested, true).map((n) => n.state)]) === "busy")
    .sort((a, b) => (a.ts || nowSeconds) - (b.ts || nowSeconds) || a.session_id.localeCompare(b.session_id));
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
    project: folderNames.get(folderKeyFor(session)) ?? session.folder.split("/").filter(Boolean).pop() ?? "",
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
// bottom-left row. Assigned by index rather than spliced, for the same reason
// the back key is: an unreadable stats cache makes the list short, and the
// way in must not move.
export const CONFIG_INDEX = 11;

// Two keys per cswap account, the active one first: its usage (the
// bottom-right key's shape, session and week %) and its resets (same shape,
// the time left in each window instead of a bar). Both carry the account's
// local part as a title, underlined on the active subscription so the pair
// the usage key is also talking about reads apart from the rest.
export function cswapTiles(accounts, now = Date.now()) {
  return accounts.flatMap((a) => {
    const head = { kind: "usage", title: a.name, active: a.active };
    return [
      { ...head, rows: [{ caps: "SESSION", pct: a.session }, { caps: "WEEK", pct: a.week }] },
      {
        ...head,
        rows: [
          { caps: "SESSION", text: formatReset(a.sessionResetsAt, "hours", now) ?? "—" },
          { caps: "WEEK", text: formatReset(a.weekResetsAt, "days", now) ?? "—" },
        ],
      },
    ];
  });
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

// The status key: who needs you, or where the spare capacity is.
//
// These were two keys. They are one because they are never both the answer:
// "10 sessions free" is not what you want to read while two are blocked on
// you, and once nothing is blocked the count of blocked things is a zero
// nobody needs a key for. So the key shows the attention queue whenever it has
// anything in it and falls back to the free queue when it does not — and the
// slot that buys goes back to the sessions, which is where a slot on a board
// about sessions should be.
//
// Both queues are computed either way: the press handler needs both counts to
// know which board a press opens, and the caller needs them to decide whether
// to leave a board that has drained. Neither is expensive — they are two
// filters over a list that has already been read.
//
// `renderParams` is cached only while the attention side is showing, because
// that is the only side that pulses; the free side has nothing to animate and
// nothing must redraw it between polls (see the overlay rule in CLAUDE.md).
async function drawStatus(deck, btn, sessions, pulse) {
  const now = Date.now() / 1000;
  const attention = attentionQueue(sessions, now);
  const free = freeQueue(sessions, now);
  const { kind, count, longest, pct, host } = statusKey(attention, free, now, allPressures());

  if (kind === "memory") {
    // The attention key's own shape and red, with the pressure where the
    // count goes and the machine's name under it — MEMORY for this one; the
    // blink window is keyed on crossing the line, not on the number moving.
    // `count` is a string so the quiet-at-zero rule stays off.
    btn.renderParams = { count: `${pct}%`, longest: "", label: host ? host.toUpperCase() : "MEMORY" };
    if (!btn.lastCount) btn.blinkUntil = Date.now() + ATTENTION_BLINK_MS;
    btn.lastCount = 1;
    const drawn = `memory ${host} ${pct} ${pulse}`;
    if (btn.drawn !== drawn) {
      await deck.fillKeyBuffer(btn.index, await renderAttention({ ...btn, ...btn.renderParams, pulse }), { format: "rgba" });
      btn.drawn = drawn;
    }
    return { attention: 0, free: free.length, memory: true };
  }

  if (kind === "attention") {
    btn.renderParams = { count, longest };
    // Restart the 5s blink window whenever the queue grows — a new session
    // waiting is news, the same ones still waiting is not.
    if (count > (btn.lastCount ?? 0)) btn.blinkUntil = Date.now() + ATTENTION_BLINK_MS;
    btn.lastCount = count;
    const drawn = `attention ${count} ${longest} ${pulse}`;
    if (btn.drawn !== drawn) {
      await deck.fillKeyBuffer(btn.index, await renderAttention({ ...btn, count, longest, pulse }), { format: "rgba" });
      btn.drawn = drawn;
    }
    return { attention: attention.length, free: free.length };
  }

  // Nothing wants you. lastCount resets with the queue, or a queue that
  // drained to zero and came back at the same size would never blink again.
  btn.lastCount = 0;
  // Nulled, not kept: only the attention side pulses, and leaving stale params
  // here would let pulse() redraw an attention frame over a free key — the
  // overlay rule, one key down.
  btn.renderParams = null;
  const drawn = `free ${count} ${longest}`;
  if (btn.drawn !== drawn) {
    await deck.fillKeyBuffer(btn.index, await renderFree({ ...btn, count, longest }), { format: "rgba" });
    btn.drawn = drawn;
  }
  return { attention: 0, free: free.length };
}

/**
 * What the status key says: the attention queue when it has anything in it,
 * the free queue when it does not.
 *
 * Exported and pure because it is the whole fold, it is written into two
 * boards — this deck and the web board — and neither is visible without the
 * hardware or a browser. The same reason `detailLayout` and `isRepeatPress`
 * are exported; `slots-check` covers it.
 *
 * `now` is an argument rather than a clock read, like `summarise`'s: the age
 * it reports is the only thing here that could quietly start lying.
 */
export const MEMORY_ALERT_PCT = 70;

export function statusKey(attention, free, now, pressures = []) {
  const oldest = (q) => (q.length && q[0].ts ? formatAge(now - q[0].ts) : "");
  if (attention.length > 0) return { kind: "attention", count: attention.length, longest: oldest(attention) };
  // Between the two queues: sessions blocked on you still come first, but a
  // machine about to swap itself to a halt outranks "where can I start the
  // next thing". `pressures` is every machine — `{host, pressure}`, host null
  // for this one — and the worst over the line is what the key names. `pct`
  // rather than `count` so no board mistakes it for one.
  const worst = pressures
    .filter((p) => typeof p.pressure === "number" && p.pressure > MEMORY_ALERT_PCT)
    .sort((a, b) => b.pressure - a.pressure)[0];
  if (worst) return { kind: "memory", pct: Math.round(worst.pressure), host: worst.host };
  return { kind: "free", count: free.length, longest: oldest(free) };
}

// One queue drawn across the session keys, the shape attention/free/busy all
// share: recognise the project and pick one, no age readout per tile (the
// status key's own longest-* line already says that once for the board
// rather than fourteen times). `kind` only reaches the drawn signature, to
// keep each board's own change-detection separate from the others'.
async function drawQueueTiles(deck, buttons, queue, kind) {
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
      // One object drives both the render call and the drawn signature, so a
      // field drawn but not signed can't happen — that's what left a tile's
      // gauge frozen once already, and dropped its task counter a second time.
      const params = { state: session.state, label, accent, project, context: session.context, progress: session.progress };
      const drawn = `${kind} ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(btn.index, await renderKey({ ...btn, ...params }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// The free queue as a board, the same shape refreshAttention has. Idle keys
// carry no urgency, so this one draws them exactly as the sessions board would
// — the point is to recognise the project and pick one, not to be alarmed.
//
// The status key shows what continuing the cycle (to busy) would open, not
// the ordinary attention/free fold `drawStatus` computes — its job here is to
// say what pressing it does next, not to re-litigate priority. See
// `drawBusyOnStatus` just below.
async function refreshFree(deck, buttons, statusButton) {
  const sessions = await liveSessions();
  const now = Date.now() / 1000;
  const queue = freeQueue(sessions, now);
  const attention = attentionQueue(sessions, now);
  await drawBusyOnStatus(deck, statusButton, busyQueue(sessions, now), now);
  await drawQueueTiles(deck, buttons, queue, "free-tile");
  return { attention: attention.length, free: queue.length };
}

// The status key mid-cycle, showing the busy count it would open next rather
// than the ordinary fold — never pulses, like the free side it continues
// from, since nothing here is urgent enough to alarm about.
async function drawBusyOnStatus(deck, btn, busy, now) {
  const oldest = busy.length && busy[0].ts ? formatAge(now - busy[0].ts) : "";
  btn.lastCount = 0;
  btn.renderParams = null;
  const drawn = `busy-status ${busy.length} ${oldest}`;
  if (btn.drawn !== drawn) {
    await deck.fillKeyBuffer(
      btn.index,
      await renderFree({ ...btn, count: busy.length, longest: oldest, label: "WORKING", quietWord: "FREE" }),
      { format: "rgba" }
    );
    btn.drawn = drawn;
  }
}

// The busy board: sessions actually at work, reached by continuing past free
// rather than picked by the fold — the third and last leg of the status key's
// own cycle. Its status key shows the ordinary attention/free readout here,
// since any press (including its own) leaves to exactly that.
async function refreshBusy(deck, buttons, statusButton) {
  const sessions = await liveSessions();
  const queue = busyQueue(sessions, Date.now() / 1000);
  const counts = await drawStatus(deck, statusButton, sessions, false);
  await drawQueueTiles(deck, buttons, queue, "busy-tile");
  return { ...counts, busy: queue.length };
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

// Stats view: the same 13 session buttons, repurposed as an all-time stats board.
// Reuses the `drawn`-signature diffing that `refresh` uses for sessions, so
// switching modes just redraws everything once (the signatures never match
// across modes) and needs no explicit invalidation.
//
// Exported for `stats-check` to drive against a fake deck. Not because the
// logic is subtle — because this function was *deleted* by an edit to the
// function above it and nothing noticed: the poll loop swallows a throw into
// a `refresh failed:` line every 2s, so the board simply stopped updating
// while the daemon went on looking healthy, and it took pressing the key to
// find out. Every board branch of that loop has the same shape, and this is
// the one of them a check can reach without a Stream Deck.
export async function refreshStats(deck, buttons, stats) {
  await Promise.all(
    buttons.map(async (btn, i) => {
      const stat = stats[i] ?? null;
      btn.assigned = null;
      btn.stat = stat; // what this key shows, for the press handler
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
      const render = stat.kind === "back" || stat.kind === "config" ? renderBack : stat.kind === "usage" ? renderUsage : renderStat;
      await deck.fillKeyBuffer(btn.index, await render({ ...btn, ...stat, big: true }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// The attention board: the queue across the session keys, re-ranked every
// poll. Unlike the detail view this deliberately re-sorts while it's up — a
// session that gets unblocked should leave the queue you're looking at.
async function refreshAttention(deck, buttons, statusButton) {
  const sessions = await liveSessions();
  const queue = attentionQueue(sessions, Date.now() / 1000);
  const counts = await drawStatus(deck, statusButton, sessions, false);
  await drawQueueTiles(deck, buttons, queue, "queue");
  // Returned like drawStatus() so the poll loop can keep both counts live
  // from this branch too — this view's own call to drawStatus is
  // buried inside here rather than at the loop's call site.
  return counts;
}

// How long today has been spent waiting on you, across every project. It sat
// on this board once, went when the free key took its slot, and comes back
// with it now that the status key has given the slot up — the same trade in
// reverse, which is what the slot arithmetic in CONFIG_INDEX's comment is
// about.
//
// Cached for the same 30s stats.mjs caches for, and for a sharper reason:
// readHistory() reads the whole log, and this board polls every 2s while it
// is up. The number moves by the minute at most.
let blockedCache = { at: 0, tile: { label: "Blocked today", value: "—" } };
function blockedTodayTile() {
  const now = Date.now();
  if (now - blockedCache.at < 30000) return blockedCache.tile;
  let ms = 0;
  try {
    const totals = summarise(readHistory(), now, startOfDay(now));
    for (const states of Object.values(totals)) ms += states.requires_action ?? 0;
  } catch {
    // Best-effort like every other reader here: an unreadable log is a dash,
    // never a board that fails to draw.
    ms = 0;
  }
  // A minute is the floor formatAge can render, and below it "0m" says less
  // than a dash does.
  blockedCache = { at: now, tile: { label: "Blocked today", value: ms < 60000 ? "—" : formatAge(ms / 1000) } };
  return blockedCache.tile;
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
  const snapshot = JSON.stringify([[...folderAccent], projectOrder, [...folderNames]]);
  if (snapshot === lastAccentsWritten) return;
  lastAccentsWritten = snapshot;
  writeProjects(folderAccent, projectOrder, folderNames);
}

// The board page's tiles, in the deck's own order and with the deck's own
// folding — but without its geometry. There is no slot cap here: an iPad is
// not 15 keys, so every session gets a tile and the page scrolls, which is
// also why the three reserved keys are appended to the list rather than
// pinned to fixed indices that only exist on a 5×3 device.
//
// Read from `lastSessions`, never from a fresh getLiveSessions(): the page
// polls on its own 2s clock, and a second pass over ~/.claude per request
// would double this daemon's filesystem work to show the same numbers the
// deck is already drawing.
//
// `?? Number.MAX_SAFE_INTEGER` rather than Infinity for the same reason
// projects() reaches for a sentinel at all — assignSlots is what fills these
// maps and it runs only on sessions-board polls, so a session that appeared
// while the stats board was up has no position yet. A finite sentinel keeps
// two unknowns comparing equal instead of subtracting to NaN.
const at = (m, k) => m.get(k) ?? Number.MAX_SAFE_INTEGER;

/**
 * The session and stand-in tiles, in the deck's own order and with the deck's
 * own folding. Pure and exported for the same reason `detailLayout` is: the
 * ordering, the primary-key rule and the state folding are exactly where an
 * off-by-one silently puts a subagent's marker on a sibling's key, and none of
 * it is visible without a deck or an iPad. `slots-check` covers it.
 *
 * `now` is an argument rather than a clock read for the reason `summarise`
 * takes one: an unreachable tile's label counts from it.
 */
export function boardTiles(sessions, unreachable = [], now = Date.now() / 1000) {
  const nested = sessions.filter((s) => s.nested);
  // Unreachable stand-ins are mixed in here exactly as refresh() mixes them
  // into assignSlots, and for the same reason: a host going quiet must move
  // its keys' *contents*, never their place on the board.
  const ordered = [...sessions.filter((s) => !s.nested), ...unreachable].sort(
    (a, b) =>
      at(folderOrder, folderKeyFor(a)) - at(folderOrder, folderKeyFor(b)) ||
      at(sessionOrder, a.session_id) - at(sessionOrder, b.session_id)
  );

  const keys = ordered.map((s, i) => {
    const accent = accentFor(folderKeyFor(s));
    const project = s.folder.split("/").filter(Boolean).pop() ?? "";
    if (s.unreachable) {
      // "offline" rather than "unreachable" to match the key on the deck —
      // there is room for the longer word here, and two boards disagreeing
      // about what a thing is called is worse than one being imprecise.
      return { id: s.session_id, kind: "offline", project, accent, label: `${s.host} offline ${formatAge(now - s.ts)}` };
    }
    const isPrimary = i === 0 || folderKeyFor(ordered[i - 1]) !== folderKeyFor(s);
    const own = nestedFor(s, nested, isPrimary).sort((a, b) => at(nestedOrder, a.session_id) - at(nestedOrder, b.session_id));
    const { label } = keyFields(s);
    return {
      id: s.session_id,
      kind: "session",
      project,
      accent,
      // The block's colour, folded over its subagents — the same call refresh()
      // makes, so a tile and its key can never disagree.
      state: mostUrgent([s.state, ...own.map((n) => n.state)]),
      // Carried separately for the same reason renderKey takes it separately:
      // `state` is the block's, and the blue shell marker is about this
      // session alone.
      shell: s.state === "shell",
      label,
      context: typeof s.context === "number" ? s.context : null,
      // taskSquares already decides which square is done, active or still to
      // do; only its geometry is for an SVG, so the width here is arbitrary.
      // Each square names its task (a title attribute is a tooltip for free);
      // the subject is what the detail panel shows for it, so the two agree.
      squares: s.progress
        ? taskSquares(s.progress, 100).map((q, i) => ({ state: q.state, title: s.progress.subjects?.[i] ? `${i + 1}. ${s.progress.subjects[i]}` : `task ${i + 1}` }))
        : [],
      nested: own.map((n) => n.state),
    };
  });

  return keys;
}

async function boardKeys() {
  const now = Date.now() / 1000;
  const sessions = lastSessions;
  const keys = boardTiles(sessions, unreachableTiles(readWindowStates()), now);
  const { session, week } = await getUsage();
  const attention = attentionQueue(sessions, now);
  const free = freeQueue(sessions, now);
  // One status tile, from the same statusKey the deck's own key is drawn from
  // — the fold is a rule, not a thing each board decides for itself. One id
  // either way, so the page's poll sees that tile *change* rather than one
  // tile being removed and another appearing in its place.
  return [
    ...keys,
    { id: "__usage", kind: "usage", session, week },
    { id: "__status", ...statusKey(attention, free, now, allPressures()) },
  ];
}

// The config server's entire coupling to this daemon. Two functions, so the
// page can be rewritten — drag-to-reorder, when it lands — without touching
// anything here, and so config-check can drive the real server with fakes.
export const configDeps = {
  projects: () =>
    [...liveProjects]
      // `renamed` is what the config page shows the reset icon on — a
      // custom name and the folder's own derived one can coincide, so this
      // has to come from whether an override exists, not from comparing
      // strings.
      .map(([key, p]) => ({ key, name: p.name, host: p.host, accent: accentFor(key), renamed: folderNames.has(key) }))
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
  setName: (folder, name) => {
    applyRename(folderNames, folder, name);
    persistAccents();
  },
  reorder: (folder, before) => {
    moveProject(projectOrder, folder, before);
    reindexProjects();
    persistAccents();
  },
  // The board and the palette its settings sheet offers. One call rather than
  // two so the page and the fragment its poll fetches can never be rendered
  // from two different reads.
  board: async () => ({ keys: await boardKeys(), projects: configDeps.projects(), palette: ACCENTS, version: pkg.version }),
  // The stats board's numbers, for the page the usage tile and the header's
  // info icon both open. Formatted here rather than in the page, the same
  // split every other route follows: index.mjs owns the clock and the units,
  // board-page.mjs owns the markup, and config-check drives the page from
  // fixed strings instead of a real rate-limit window.
  //
  // The reset times are the half the deck has to spend two whole keys on
  // ("Session reset 3h", "Week reset 5d") because a key cannot hold a
  // percentage and its window at once. Here they sit under their own meter,
  // which is the point of the page having a different shape.
  status: async () => {
    const { session, week, sessionResetsAt, weekResetsAt } = await getUsage();
    return {
      usage: {
        session,
        week,
        sessionResets: formatReset(sessionResetsAt, "hours") ?? "",
        weekResets: formatReset(weekResetsAt, "days") ?? "",
      },
      stats: await getStats(),
      blocked: blockedTodayTile().value,
      version: pkg.version,
      account: await getAccountName(),
      // This machine first, then every reachable host, under its name.
      memory: [{ name: "This Mac", ...getMemory() }, ...Object.entries(hostMemories()).map(([name, m]) => ({ name, ...m }))],
      accounts: withLiveUsage(await getCswapAccounts(), { session, week, sessionResetsAt, weekResetsAt }).map((a) => ({
        name: a.email,
        active: a.active,
        usage: {
          session: a.session,
          week: a.week,
          sessionResets: formatReset(a.sessionResetsAt, "hours") ?? "",
          weekResets: formatReset(a.weekResetsAt, "days") ?? "",
        },
      })),
    };
  },
  // One session at length, for the panel the board's second tap opens. The
  // deck's detail board reads its tasks per poll rather than in
  // getLiveSessions for a reason that holds here too — this costs nothing
  // until someone is actually looking at one session.
  //
  // Null for an id nothing on the board matches, which covers both a made-up
  // one and a session that ended while the panel was open. Nested sessions
  // are deliberately reachable by id: they have no tile of their own, but the
  // panel lists them and a future tap on one should find something here.
  detail: async (id) => {
    const session = lastSessions.find((s) => s.session_id === id);
    if (!session) return null;
    // `primary` is true for the same reason refreshDetail passes it: a detail
    // view is the one place per project you can be looking at, so an SDK
    // session with no parent to point at belongs on it.
    const nested = nestedFor(session, lastSessions.filter((s) => s.nested), true);
    // Same null-for-remote rule as the deck's: readLedgerTasks needs a path on
    // *this* machine, and a remote session's cwd is not one.
    const tasks = await readTaskList(session.session_id, session.root, session.host ? null : session.cwd);
    const { label, project, age } = keyFields(session);
    return {
      id,
      project,
      label,
      age,
      accent: accentFor(folderKeyFor(session)),
      state: session.state,
      context: typeof session.context === "number" ? session.context : null,
      // "claude-opus-5" is three quarters vendor, on a key or anywhere else.
      model: [(session.model ?? "").replace(/^claude-/, ""), session.effort ?? ""].filter(Boolean).join(" ") || "—",
      host: session.host ?? null,
      // Which subscription this session is actually running under — the
      // whole reason to ask per session rather than once for the board: two
      // hosts can be signed into two different accounts (this Mac just
      // switched with cswap, a remote box may not have). Only known for a
      // local session: `getAccountName` reads *this* machine's
      // `~/.claude.json`, and nothing here fetches a remote host's — a
      // remote session's account is honestly unknown rather than guessed at.
      account: session.host ? null : await getAccountName(),
      cwd: session.cwd,
      // The whole list, not taskWindow's slice: the window exists because
      // twelve keys cannot hold twenty tasks, and a scrolling page can.
      tasks: tasks.map((t, i) => ({ n: i + 1, subject: t.subject ?? "", status: t.status ?? "pending" })),
      // Likewise all of them, rather than however many the tail had room for.
      nested: nested.map((n) => ({ id: n.session_id, state: n.state, label: keyFields(n).label })),
    };
  },
  // Formatted here rather than in the page: config-server.mjs owns markup and
  // nothing else, which is what lets config-check render the table from three
  // fixed strings instead of reconstructing a day of history.
  //
  // Every project the history knows, not just the live ones — the question is
  // where the week went, and a project you closed an hour ago is exactly the
  // kind of answer that would go missing. Ordered by today's blocked time,
  // because that is the column the page exists for.
  activity: (period) => {
    const now = Date.now();
    const records = readHistory();
    const buckets = readTokens();
    const p = PERIODS[period] ? period : DEFAULT_PERIOD;
    const { step, unit, every, format, title } = PERIODS[p];
    // "All time" starts at the oldest thing either log remembers, which is not
    // the same date for the two of them: tokens are kept a year and state
    // history a month. The striped columns say so — that asymmetry is exactly
    // what "unobserved" was built to draw.
    const oldest = Math.min(earliestBucket(buckets) ?? now, records[0]?.ts ?? now);
    const span = PERIODS[p].span ?? Math.max(now - oldest, step);
    const from = Math.floor((now - span) / step) * step;
    // Ceiling, not round: `from` is floored to a bucket boundary, so the
    // window always spills into one more bucket than its span — the partial
    // one happening right now. Rounding drops it, and since the label run is
    // anchored on the last index, an off-by-one there is exactly the newest
    // column going unlabelled.
    const cols = Math.max(1, Math.ceil((now - from) / step));

    // The table follows the window too, so there is one time control on the
    // page rather than a picker above charts and a fixed today/week pair
    // below it. Idle is deliberately not in here: a session sitting open is
    // not time that went anywhere, and the three that remain are what the
    // question means.
    const totals = summarise(records, now, from);
    const dur = (ms) => (!ms || ms < 60000 ? "—" : formatAge(ms / 1000));
    const spent = (st = {}) => (st.busy ?? 0) + (st.shell ?? 0) + (st.waiting ?? 0) + (st.requires_action ?? 0);
    const tracked = Object.values(totals).reduce((a, st) => a + spent(st), 0);
    // Sorted by the pie's own metric, not by blocked time as it was before the
    // pie existed: a slice and its row have to be findable from each other, and
    // that only works if the table is in slice order. The blocked column keeps
    // its colour, which is what drew the eye to it in the first place.
    const rows = Object.entries(totals)
      // A minute is the floor `dur` can render, so anything under it is a row
      // of four em dashes and a slice too thin to see. Same threshold in both
      // places rather than two that nearly agree.
      .filter(([key, st]) => key && spent(st) >= 60000)
      .map(([key, st]) => ({
        key,
        name: liveProjects.get(key)?.name ?? key.split("/").filter(Boolean).pop() ?? key,
        // The colour it wears on the deck, so the pie needs no legend of its
        // own — folderAccent survives restarts, so a project that has closed
        // since still shows in the colour you remember it by. A project this
        // daemon has never seen gets the neutral, which is the same grey an
        // idle key is drawn in.
        accent: folderAccent.get(key) ?? "#555555",
        busy: dur((st.busy ?? 0) + (st.shell ?? 0)),
        waiting: dur(st.waiting),
        blocked: dur(st.requires_action),
        total: dur(spent(st)),
        pct: tracked ? (spent(st) / tracked) * 100 : 0,
        spentMs: spent(st),
      }))
      .sort((a, b) => b.spentMs - a.spentMs);

    // Cumulative stops rather than shares: a conic-gradient wants "this colour
    // from here to there", and doing that running total in the page would put
    // arithmetic in the one file that is supposed to hold none.
    let at = 0;
    const slices = rows.map((r) => {
      const slice = { accent: r.accent, from: at, to: Math.min(100, at + r.pct) };
      at = slice.to;
      return slice;
    });
    const pie = { slices, total: dur(tracked), label: PERIODS[p].name };

    // Only some columns carry a label — 30 of them under 30 columns is a smear
    // — and the run is anchored on the *newest* bucket rather than on the
    // clock, so the rightmost column is always named and the labels don't
    // shuffle as the window slides.
    const tickAt = (i) => ((cols - 1 - i) % every === 0 ? format(new Date(from + i * step)) : "");
    // Tokens never bucket finer than an hour — `summariseTokens` floors to it
    // regardless of `step` — so a period whose own step goes sub-hourly (12h,
    // at 15 minutes, for the concurrency and memory charts) would otherwise
    // hand the token/input charts a `tickAt` built for four times as many
    // columns as they actually have. A second tick function, floored the same
    // way `summariseTokens` floors its buckets, is what keeps their axis
    // labels naming the column that's actually there.
    const tokenStep = Math.max(HOUR_MS, Math.round(step / HOUR_MS) * HOUR_MS);
    const tokenCols = Math.max(1, Math.ceil((now - from) / tokenStep));
    const tokenTickAt = (i) => ((tokenCols - 1 - i) % every === 0 ? format(new Date(from + i * tokenStep)) : "");
    // Bars are a percentage of the busiest column, not of a fixed ceiling:
    // these series span three orders of magnitude between a quiet hour and a
    // fan-out, and anything absolute draws every ordinary column as a sliver.
    const scale = (values) => Math.max(1, ...values);

    const perBucket = summariseTokens(buckets, from, now, step);
    const peakOut = scale(perBucket.map((r) => r.out));
    // Only vendors that actually ran in this window get a colour and a legend
    // entry — a machine that has never run the ship review must not grow a
    // legend explaining a colour it will never see.
    const providers = [...new Set(perBucket.flatMap((r) => Object.keys(r.outBy)))].sort();
    // Money is its own line, not another number in the heading: every rung but
    // the metered one is zero by construction — prepaid, not free — so a total
    // that is zero says "no API review ran in this window" and is worth not
    // printing at all.
    const spend = perBucket.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    const reviews = perBucket.reduce((a, r) => a + (r.apiCalls ?? 0), 0);
    const tokens = {
      peak: `${compactCount(peakOut)}/${unit}`,
      cost: spend > 0 ? `$${spend.toFixed(2)} billed to the metered API · ${reviews} review${reviews === 1 ? "" : "s"}` : null,
      providers,
      cols: perBucket.map((r, i) => ({
        label: title(new Date(r.hour)),
        tick: tokenTickAt(i),
        bars: providers
          .filter((v) => r.outBy[v])
          .map((v) => ({ state: v, pct: (r.outBy[v] / peakOut) * 100 })),
        value: providers.length > 1
          ? providers.filter((v) => r.outBy[v]).map((v) => `${v} ${compactCount(r.outBy[v])}`).join(" · ") || "—"
          : compactCount(r.out),
      })),
    };

    // Input, on its own chart: it runs two orders of magnitude above output
    // here (cache reads dominate), so sharing an axis would flatten output to
    // a sliver. Stacked by kind, since "how much was cache" is the question.
    const INPUT_KINDS = [
      ["input", (r) => r.in],
      ["cache-read", (r) => r.cacheRead],
      ["cache-write", (r) => r.cacheWrite5m + r.cacheWrite1h + r.cacheWrite],
    ];
    const inputOf = (r) => INPUT_KINDS.reduce((a, [, f]) => a + f(r), 0);
    const peakIn = scale(perBucket.map(inputOf));
    const input = {
      peak: `${compactCount(peakIn)}/${unit}`,
      cols: perBucket.map((r, i) => ({
        label: title(new Date(r.hour)),
        tick: tokenTickAt(i),
        bars: INPUT_KINDS.filter(([, f]) => f(r)).map(([state, f]) => ({ state, pct: (f(r) / peakIn) * 100 })),
        value: inputOf(r) ? INPUT_KINDS.filter(([, f]) => f(r)).map(([k, f]) => `${k} ${compactCount(f(r))}`).join(" · ") : "—",
      })),
    };

    // A model belongs to exactly one vendor, so one pass builds the lookup and
    // each bar wears the colour its meter has in the chart above — rather than
    // every model reading as one pool.
    const vendorOf = new Map(buckets.map((b) => [b.model ?? "", b.provider ?? "claude"]));
    const byModel = groupTokens(buckets, "model", from, now);
    const peakModel = scale(byModel.map((r) => r.out));
    const models = byModel.slice(0, 6).map((r) => ({
      // "claude-opus-5" is mostly vendor, the same reason the detail board
      // strips it, and a dated id (haiku-4-5-20251001) is mostly date; "" is
      // what a transcript line without a model reads as.
      label: (r.model || "unknown").replace(/^claude-/, "").replace(/-\d{8}$/, ""),
      bars: [{ state: vendorOf.get(r.model) ?? "tokens", pct: (r.out / peakModel) * 100 }],
      value: compactCount(r.out),
    }));

    const peaks = concurrency(records, from, now, now, step);
    const peakAny = scale(peaks.map((r) => r.any));
    const sessions = {
      peak: `max ${peakAny}`,
      cols: peaks.map((r, i) => ({
        label: title(new Date(r.hour)),
        tick: tickAt(i),
        // A bucket nobody watched draws striped and empty. It is not an idle
        // one and the two must not look alike — see history.mjs's TICK.
        unseen: r.samples === 0,
        bars: ["busy", "shell", "requires_action", "waiting", "idle"]
          .filter((state) => r.states[state])
          .map((state) => ({ state, pct: (r.states[state] / peakAny) * 100 })),
        value: r.samples === 0 ? "not watched" : `${r.any} open`,
      })),
    };

    // Memory, one pair of charts per machine — this one first, then every
    // host any tick in the window reported for (a host that has gone away
    // still has its history). Pressure is against a fixed 100 rather than
    // the busiest column — it is a percentage, and 40% has to look like 40%
    // whatever the window held — red over the same line the status key
    // alerts on; the sessions' own resident footprint scales to its busiest
    // column like the token charts, an amount rather than a share.
    const gb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
    const memoryCharts = (name, host) => {
      const mem = memorySeries(records, from, now, step, host);
      const peakMem = Math.max(0, ...mem.map((r) => r.pressure));
      // The newest total the window saw — a machine's RAM doesn't change
      // between samples, so it's the one figure for the heading.
      const totalMb = mem.map((r) => r.totalMb).filter(Boolean).pop() ?? null;
      const peakClaude = Math.max(1, ...mem.map((r) => r.claudeMb));
      return {
        name,
        pressure: {
          peak: `max ${pctWithAmount(peakMem, totalMb)}`,
          cols: mem.map((r, i) => ({
            label: title(new Date(r.hour)),
            tick: tickAt(i),
            unseen: r.samples === 0,
            bars: r.samples === 0 ? [] : [{ state: r.pressure > MEMORY_ALERT_PCT ? "memory-high" : "memory", pct: r.pressure }],
            value: r.samples === 0 ? "not watched" : `pressure ${pctWithAmount(r.pressure, r.totalMb)} · swap ${pctWithAmount(r.swap, r.swapTotalMb)}`,
          })),
        },
        claude: {
          peak: `max ${gb(peakClaude)}`,
          cols: mem.map((r, i) => ({
            label: title(new Date(r.hour)),
            tick: tickAt(i),
            unseen: r.samples === 0,
            bars: r.claudeMb ? [{ state: "claude", pct: (r.claudeMb / peakClaude) * 100 }] : [],
            value: r.samples === 0 ? "not watched" : `${gb(r.claudeMb)} · ${r.claudeCount} session${r.claudeCount === 1 ? "" : "s"}`,
          })),
        },
      };
    };
    const memory = [memoryCharts("This Mac", null), ...memoryHosts(records).map((h) => memoryCharts(h, h))];

    return { period: p, periods: PERIOD_LINKS, rows, pie, tokens, input, models, sessions, memory };
  },
};

// The windows the activity charts offer, and the bucket each one groups into.
// Column counts are kept in the 24–52 band on purpose: fewer and a bar chart
// is a table, more and the columns are thinner than the gaps between them.
//
// The stored data is hourly, so every step here is a whole number of hours and
// nothing needs re-reading to change window — a month is the same records
// regrouped. `every` is how many columns apart the x-axis labels sit, chosen so
// the labels themselves land on something meaningful: a day boundary at 6h
// buckets, roughly a working week at daily ones.
const PERIODS = {
  // 15-minute buckets rather than hourly: this is the one period short
  // enough that sub-hour resolution actually shows something a coarser bar
  // wouldn't (a 15-minute fan-out is a whole column here, a sliver of an
  // hourly one). `unit` stays "h", not "15m" — the token/input charts still
  // bucket hourly regardless (`summariseTokens`'s own floor), so their peak
  // label has to keep describing what they actually show; only the
  // concurrency and memory charts, sampled every 5 minutes, get the finer
  // step. 48 columns (12h / 15m), comfortably inside the 24-52 band.
  "12h": { name: "12 hours", span: 12 * 3600000, step: 900000, unit: "h", every: 4,
    format: (d) => `${d.getHours()}h`,
    title: (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
  "24h": { name: "24 hours", span: 24 * 3600000, step: 3600000, unit: "h", every: 3,
    format: (d) => `${d.getHours()}h`,
    title: (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
  "7d": { name: "7 days", span: 7 * 86400000, step: 6 * 3600000, unit: "6h", every: 4,
    format: (d) => d.toLocaleDateString([], { weekday: "short" }),
    title: (d) => d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) },
  "30d": { name: "30 days", span: 30 * 86400000, step: 86400000, unit: "day", every: 5,
    format: (d) => d.toLocaleDateString([], { day: "numeric", month: "short" }),
    title: (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) },
  "3mo": { name: "3 months", span: 90 * 86400000, step: 2 * 86400000, unit: "2d", every: 9,
    format: (d) => d.toLocaleDateString([], { day: "numeric", month: "short" }),
    title: (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) },
  // Double "3mo"'s span at double its step (4 days rather than 2), landing on
  // the same 45 columns rather than drifting outside the 24-52 band.
  "6mo": { name: "6 months", span: 180 * 86400000, step: 4 * 86400000, unit: "4d", every: 9,
    format: (d) => d.toLocaleDateString([], { day: "numeric", month: "short" }),
    title: (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) },
  // A capped year at "all"'s own weekly step (53 columns) — "all" is what's
  // left for whatever is actually open-ended past this.
  "1y": { name: "1 year", span: 365 * 86400000, step: 7 * 86400000, unit: "week", every: 9,
    format: (d) => d.toLocaleDateString([], { day: "numeric", month: "short" }),
    title: (d) => `week of ${d.toLocaleDateString([], { day: "numeric", month: "short" })}` },
  // No span: "all" is however far back the logs go, which is up to a year for
  // tokens and a month for state history.
  all: { name: "all time", span: null, step: 7 * 86400000, unit: "week", every: 4,
    format: (d) => d.toLocaleDateString([], { day: "numeric", month: "short" }),
    title: (d) => `week of ${d.toLocaleDateString([], { day: "numeric", month: "short" })}` },
};
const DEFAULT_PERIOD = "24h";
// The page renders links, not a select — it owns markup and nothing else, so
// the set of windows and their names live here with the arithmetic.
const PERIOD_LINKS = Object.entries(PERIODS).map(([key, v]) => ({ key, name: v.name }));

/**
 * A token count at a glance: 899k, 1.2M, 3.7B.
 *
 * Three significant figures at most — these are read off a bar chart to
 * compare hours, and the exact digit count of a cache-read total is noise at
 * that job.
 */
export function compactCount(n) {
  if (!n) return "—";
  for (const [limit, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
    if (n >= limit) {
      const scaled = n / limit;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(n);
}

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
  // Same null-for-remote rule as the progress bar: readLedgerTasks reads a
  // path on this machine, and a remote session's cwd isn't one.
  const tasks = await readTaskList(session.session_id, session.root, session.host ? null : session.cwd);
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
async function pulse(deck, buttons, statusButton, isOverlayView, isDisconnected) {
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
            const params = statusButton.renderParams;
            const blinking = !!params?.count && params.count !== 0 && Date.now() < (statusButton.blinkUntil ?? 0);
            if (!params || (!blinking && !statusButton.blinkSettle)) return [];
            statusButton.blinkSettle = blinking;
            return [
              (async () => {
                const buf = await renderAttention({ ...statusButton, ...params, pulse: blinking && bright });
                await deck.fillKeyBuffer(statusButton.index, buf, { format: "rgba" });
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

// No deck plugged in: the board page and config server are still worth
// running, so stand in a device with the MK.2's shape whose draws go nowhere.
// Every draw path is handed its deck, so nothing else has to know.
// ponytail: no hot-plug — a deck plugged in later needs a restart.
function headlessDeck() {
  const noop = async () => {};
  return {
    PRODUCT_NAME: "no Stream Deck (web board only)",
    CONTROLS: Array.from({ length: 15 }, (_, index) => ({ type: "button", index, pixelSize: { width: 72, height: 72 } })),
    fillKeyBuffer: noop, clearPanel: noop, close: noop, on() {},
  };
}

async function run() {
  const devices = await listStreamDecks();
  const deck = devices.length === 0 ? headlessDeck() : await openStreamDeck(devices[0].path);
  activeDeck = deck;
  // Read here rather than at module scope: importing this file must not touch
  // the real ~/.claude, or every check inherits this machine's live palette.
  const remembered = readProjects();
  loadAccents(remembered.accents, remembered.order, remembered.names);
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
  // Keys are row-major, so the bottom row is the last two indices: usage/stats
  // at 14 and the status key at 13, leaving 13 session slots.
  //
  // Those two questions — "who needs me" and "where can I put the next thing"
  // — are still both answered *completely*, from the whole session list rather
  // than the visible one, which is what lets the board stop having to fit. But
  // they are never both the answer at the same moment: "10 free" is not what
  // you want to read while two sessions are blocked on you, and once nothing
  // is blocked the blocked count is a zero nobody needs a key for. So one key
  // shows whichever is worth reading (`drawStatus`) and the slot that buys
  // goes back to the sessions, which is where a slot on a board about sessions
  // belongs.
  const usageButton = allButtons.pop();
  const statusButton = allButtons.pop();
  // The detail board takes over the entire deck, so it needs the full list —
  // every other board draws only the session keys.
  const allKeys = [...allButtons, statusButton, usageButton].sort((a, b) => a.index - b.index);
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
  //   { kind: "free" }
  //   { kind: "detail", session_id, tiles }
  // `tiles` is filled in by the first refreshDetail after the view opens and
  // then held, so the board's shape stays put while its content updates.
  let view = { kind: "sessions" };
  // Memory keys in GB rather than %, flipped by pressing one. Outside `view`
  // so it survives leaving and reopening the stats board.
  let memGb = false;
  // Latest attentionQueue length, kept here so the press handler can read it
  // without a second query — drawAttention returns it on every call, this
  // just holds the most recent value.
  let attentionCount = 0;
  // The same, for the free key. Read by its press handler so a dark key with
  // nothing free opens nothing rather than an empty board.
  let freeCount = 0;
  let memoryAlert = false;
  // The same again, for the busy board the status key reaches by continuing
  // past free rather than exiting — the third leg of its own cycle.
  let busyCount = 0;
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

  // The board's two extra deps. `focus` closes over `requestedAt` because a
  // tap on the iPad is the same act as a press on the deck and has to leave
  // the same trace — without it, isRepeatPress would read a session revealed
  // from the iPad as one that has never been revealed at all.
  const serverDeps = {
    ...configDeps,
    focus: (id) => {
      const session = lastSessions.find((s) => s.session_id === id);
      // Not awaited and it cannot throw, same as a key press: focusWindow
      // swallows its own failures and the board has nothing to report either
      // way.
      if (session) focusWindow(session, requestedAt);
    },
  };

  // The one thing here that accepts a connection rather than reading a file,
  // and now the one that accepts it from off this machine. That is what the
  // board is for — an iPad has no other way in — and it is why this is the
  // second thing in the project with an explicit off switch, beside
  // STREAMDECK_NO_REMOTE. Skipped, the config key still works: openConfig
  // starts the same server on loopback instead.
  if (process.env.STREAMDECK_NO_BOARD !== "1") {
    try {
      // `remember` is what makes the address survive a restart: the same port
      // and the same token, so a page left open on an iPad reconnects on its
      // own rather than sitting grey until someone scans a new code. Both
      // halves have to persist — a fixed port with a fresh token every start
      // is still a dead bookmark. STREAMDECK_PORT overrides, for a machine
      // where the default is spoken for by something you would rather keep.
      const wanted = Number(process.env.STREAMDECK_PORT) || undefined;
      const { port, token, warning } = await startServer(serverDeps, "0.0.0.0", { port: wanted, remember: true });
      const ip = lanAddress();
      const boardUrl = `http://${ip ?? "127.0.0.1"}:${port}/board?t=${token}`;
      // Printed as text as well as scanned: lanAddress takes the first
      // non-internal IPv4 it finds, which on a machine with a VPN or Docker
      // up can be the wrong one, and the line beside the QR is how you see
      // that rather than wondering why the iPad can't connect.
      console.log(`board: ${boardUrl}`);
      // Before the QR rather than after it: the code is seventeen lines tall,
      // and a warning above it is the thing you are still looking at when you
      // reach for the iPad and find the old bookmark dead.
      if (warning) console.warn(`board: ${warning}`);
      qrcode.generate(boardUrl, { small: true }, (qr) => console.log(qr));
    } catch (err) {
      // Best-effort like every other risky path here — the deck is untouched.
      console.error("board server failed:", err?.message ?? err);
    }
  }
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
  // force a repaint. Nulling statusButton.drawn on every transition costs
  // one redundant redraw at worst and guarantees the next drawAttention call
  // repaints it for real.
  // It also clears the press chain, which matters for the transitions the poll
  // loop makes on its own: a detail board whose session ends drops you back to
  // the sessions board still holding the press that opened it, and the next
  // press on that project would reopen the board you were just thrown out of.
  // Presses that do want to seed a chain set `lastPress` after calling this.
  const setView = (next) => {
    view = next;
    statusButton.drawn = null;
    lastPress = null;
  };
  deck.on("error", (err) => {
    console.error("Stream Deck error:", err);
    disconnected = true;
  });
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const isUsage = control.index === usageButton.index;
    const isStatus = control.index === statusButton.index;
    const btn = isUsage || isStatus ? null : buttons[control.index];
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
    // Attention and busy are the terminal legs of their own cycles: any press
    // leaves, the way this board always has.
    if (view.kind === "attention" || view.kind === "busy") {
      setView({ kind: "sessions" });
      // A session key still focuses its window on the way out — that's the
      // whole point of pressing one there.
      if (btn?.assigned) focusWindow(btn.assigned, requestedAt);
      lastPress = press;
      return;
    }
    // Free is the one board with a next step: the status key continues its
    // own cycle (free -> busy) here instead of exiting like every other key
    // on this board — the same "press opens what it's showing" rule the key
    // already follows on the sessions board, carried one step further. Any
    // other key still exits and focuses, same as attention/busy.
    if (view.kind === "free") {
      if (isStatus) {
        setView({ kind: "busy" });
        return;
      }
      setView({ kind: "sessions" });
      if (btn?.assigned) focusWindow(btn.assigned, requestedAt);
      lastPress = press;
      return;
    }
    if (isUsage) {
      setView(view.kind === "stats" ? { kind: "sessions" } : { kind: "stats" });
      return;
    }
    if (isStatus) {
      // Whichever queue the key is currently showing — the same order
      // drawStatus draws in, so a press opens the thing you were looking at
      // rather than a board the key never mentioned. Both counts come from
      // the last drawStatus().
      if (attentionCount > 0) setView({ kind: "attention" });
      // The memory alert opens the stats board, where the memory key lives.
      else if (memoryAlert) setView({ kind: "stats" });
      else if (freeCount > 0) setView({ kind: "free" });
      // Nothing to open: it changes no view, so it clears the chain itself —
      // a key that does nothing must still count as "something else in
      // between". setView clears it on the other two paths.
      else lastPress = null;
      return;
    }
    if (view.kind === "stats") {
      // Stat tiles aren't clickable, save three: the back key, the config
      // key, and any memory key. (The usage key still toggles the board off,
      // handled above.)
      if (buttons[control.index]?.stat?.memory) {
        // Toggles the unit on every memory key; the next stats poll redraws
        // them, since the rows change and so does their signature.
        memGb = !memGb;
        lastPress = null;
        return;
      }
      if (control.index === DETAIL_BACK_INDEX) setView({ kind: "sessions" });
      if (control.index === CONFIG_INDEX) {
        // Not awaited, and it cannot throw: a press is a synchronous handler,
        // and openConfig swallows everything the way every other risky path
        // here does.
        void openConfig(serverDeps);
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
  pulse(deck, buttons, statusButton, () => view.kind !== "sessions", () => disconnected);

  while (!disconnected) {
    try {
      if (view.kind === "stats") {
        // Every subscription cswap knows about, active first, two keys each
        // (usage, resets), then the version. Read off cswap's own cache —
        // nothing here fetches — so a machine without it has only the version
        // here. Sliced at the back key: four accounts is the most that fits.
        const versionTile = { label: "Version", value: pkg.version };
        // This machine's memory, in the account keys' shape: pressure and
        // swap in use, no border since it's neither active nor inactive.
        // A press on any memory key flips every one of them between the
        // percentage and the amount (`memGb`) — GB is the whole-board
        // answer to "how much", not a per-key setting. The bar stays: the
        // amount rides over the same gauge, so red at 90% is red at 57 GB.
        const amt = (pct, totalMb) =>
          typeof pct === "number" && totalMb ? `${((pct / 100) * totalMb) / 1024 >= 10 ? Math.round(((pct / 100) * totalMb) / 1024) : (((pct / 100) * totalMb) / 1024).toFixed(1)}G` : "—";
        const memTile = (title, m) => ({
          kind: "usage",
          title,
          memory: true,
          rows: memGb
            ? [{ caps: "RAM", pct: m.pressure, text: amt(m.pressure, m.totalMb) }, { caps: "SWAP", pct: m.swap, text: amt(m.swap, m.swapTotalMb) }]
            : [{ caps: "RAM", pct: m.pressure }, { caps: "SWAP", pct: m.swap }],
        });
        const memoryTiles = [memTile("memory", getMemory()), ...Object.entries(hostMemories()).map(([h, m]) => memTile(h, m))];
        // Accounts lead, the version beside them, then the memory keys on a
        // row of their own — read as two things, not one run — padded to the
        // next row only when the memory keys still fit above the back key.
        const head = [...cswapTiles(withLiveUsage(await getCswapAccounts(), await getUsage())), versionTile];
        const nextRow = Math.ceil(head.length / 5) * 5;
        const pad = nextRow + memoryTiles.length <= DETAIL_BACK_INDEX ? Array(nextRow - head.length).fill(null) : [];
        const statTiles = [...head, ...pad, ...memoryTiles].slice(
          0,
          DETAIL_BACK_INDEX
        );
        // Same fixed slot as the detail board's back key, and assigned by
        // index rather than spliced: with an unreadable stats cache the list
        // is short, and the way out must still be on the bottom-left button.
        statTiles[DETAIL_BACK_INDEX] = { kind: "back" };
        statTiles[CONFIG_INDEX] = { kind: "config", glyph: "⚙", caps: "CONFIG" };
        await refreshStats(deck, buttons, statTiles);
        const statsSessions = await liveSessions();
        ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, statsSessions, false));
      } else if (view.kind === "free") {
        ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await refreshFree(deck, buttons, statusButton));
        // Same exit as the attention board, for the same reason: a drained
        // queue is twelve dark keys and a dim BUSY key, which at a glance is
        // the daemon having died. Guarded on the view still being this one —
        // refreshFree just awaited a live read, and a press during that await
        // can already have moved elsewhere.
        if (freeCount === 0 && view.kind === "free") {
          setView({ kind: "sessions" });
          const sessions = await refresh(deck, buttons, slots, nestedBySlot);
          ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, sessions, false));
        }
      } else if (view.kind === "busy") {
        ({ attention: attentionCount, free: freeCount, busy: busyCount } = await refreshBusy(deck, buttons, statusButton));
        // Same exit as attention/free, for the same reason: a drained queue
        // reads as the daemon having died, not as "nothing's running right
        // now". Guarded the same way — refreshBusy just awaited a live read.
        if (busyCount === 0 && view.kind === "busy") {
          setView({ kind: "sessions" });
          const sessions = await refresh(deck, buttons, slots, nestedBySlot);
          ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, sessions, false));
        }
      } else if (view.kind === "attention") {
        ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await refreshAttention(deck, buttons, statusButton));
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
          ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, sessions, false));
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
          ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, sessions, false));
        }
        // No drawAttention, no drawFree, and no drawUsage below: the detail board owns
        // all 15 keys, so anything else painting keys 12, 13 and 14 fights it
        // for them and both flip back and forth on every poll. `attentionCount`
        // going stale while the board is up is harmless — the only press it
        // gates is on the attention key, which is a detail tile right now.
      } else {
        const sessions = await refresh(deck, buttons, slots, nestedBySlot);
        ({ attention: attentionCount, free: freeCount, memory: memoryAlert = false } = await drawStatus(deck, statusButton, sessions, false));
        // One read serves both: the coverage log below, and `everActive` —
        // `isRepeatPress` needs a session ever reported active by *some* poll,
        // not just this one, so it's accumulated rather than replaced.
        const windowStates = readWindowStates();
        for (const w of windowStates) {
          if (w.activeSessionId) everActive.add(w.activeSessionId);
        }
        const withExt = windowStates.length;
        const remoteIde = remoteIdeDirs();
        const total = countVsCodeWindows(undefined, windowStates, remoteIde);
        const coverage = `${withExt}/${total}`;
        // `lastCoverage` moves on every change, not just the ones that print:
        // it is the "has this already been said" guard, and skipping the
        // update on a covered poll would leave it stale, so going covered and
        // back to short again would say nothing the second time.
        if (coverage !== lastCoverage) {
          lastCoverage = coverage;
          // Only when a window is actually missing it. Full coverage is the
          // normal case and there is nothing to do about it, so saying so is a
          // line that scrolls past on every start and trains you to ignore the
          // one that matters.
          //
          // `<`, not `!==`: `total` only counts windows running the Claude
          // Code extension (the IDE locks), `withExt` counts windows running
          // *this* extension. A window with Claude Code disabled but this
          // extension still active makes withExt > total, and `!==` would then
          // take the reload-the-rest branch forever, on a machine that's
          // already fully covered.
          if (withExt < total) {
            // Which ones, not just how many. The join is on folders — every IDE
            // lock reports VS Code's shared main-process pid, so there is no
            // per-window identity to match the extension host's — which means
            // two windows on one folder can only be reported as a count. It
            // says "1 of 2" there rather than naming a window it cannot tell
            // apart from its twin.
            const stale = staleWindows(undefined, windowStates, remoteIde);
            const which = stale
              .map((w) => (w.open > 1 ? `${w.name} (${w.covered} of ${w.open} windows)` : w.name))
              .join(", ");
            console.log(
              // Remote windows are in this count once their host has been
              // fetched (its ide/ rides the tree), and are named host:folder —
              // kob-backend is open on both sides of this machine's ssh.
              `vscode terminal focus: ${coverage} windows have the extension — reload ${which || "the rest"} (Developer: Reload Window)`
            );
          }
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
