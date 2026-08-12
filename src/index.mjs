import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import { getLiveSessions, readTaskList, taskWindow } from "./sessions.mjs";
import { openFileIn } from "./vscode-state.mjs";
import { renderKey, renderBlank, renderUsage, renderStat, renderAttention, renderTask, formatAge, splitLabel } from "./render.mjs";
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
const ANCHOR_CANDIDATES = ["package.json", "README.md", "AGENTS.md", "CLAUDE.md", ".gitignore"];

// Accent colours identifying which VS Code window a session belongs to.
// Assigned in first-seen order rather than by hashing the path: hashing is
// stable across restarts but can hand two windows the same colour, and
// telling windows apart is the whole point. Sorting would instead reshuffle
// existing colours whenever a new window appears.
const ACCENTS = ["#4fc3f7", "#ff8a65", "#ba68c8", "#fff176", "#4db6ac", "#f06292", "#aed581", "#a1887f"];

// First-seen order for both grouping and colour, so a project's block and its
// stripe always agree. Folders are kept after their last session ends: if the
// project comes back it reclaims its old position and colour instead of
// jumping to the end.
const folderOrder = new Map();
const sessionOrder = new Map();
const nestedOrder = new Map();
// Sessions ever seen with a non-nested cwd. Never pruned, same as folderOrder:
// a set of dead session ids costs nothing, and a resumed session keeping its
// real button is the behaviour we want anyway.
const everReal = new Set();
let arrivals = 0;

// Colour is picked from what no other live folder is using, not from
// ACCENTS[position % 8]. Position grows for the daemon's lifetime and is
// deliberately never pruned, so the modulo guaranteed a collision: once nine
// folders have been seen, positions 0 and 8 are the same colour, and two
// projects sharing one defeats the entire purpose of the accent.
//
// Assigned once, at first sight of a folder, and kept — a project that goes
// away and comes back reclaims its colour, as it reclaims its slot. The
// remaining collision is a folder returning after its colour was handed to
// someone else; rarer than the modulo wrap, and not worth recolouring a
// settled board to prevent.
const folderAccent = new Map();
function claimAccent(folder, liveFolders) {
  const taken = new Set([...liveFolders].filter((f) => f !== folder).map((f) => folderAccent.get(f)));
  return ACCENTS.find((c) => !taken.has(c)) ?? ACCENTS[folderAccent.size % ACCENTS.length];
}

export function accentFor(folder) {
  return folderAccent.get(folder) ?? ACCENTS[0];
}

// Least to most urgent. A key takes the most urgent state among itself and
// the subsessions folded onto it, so a project whose only activity is in a
// worktree still reads as working. An unrecognised state ranks below all of
// them rather than winning by accident — render.mjs already falls back to
// idle's colour for anything it doesn't know.
const STATE_URGENCY = ["idle", "shell", "busy", "waiting", "requires_action"];
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
async function focusWindow(folder, ide) {
  const app = ide ?? "Visual Studio Code";
  const file = (app === "Visual Studio Code" ? await openFileIn(folder) : null) ?? (await anchorFile(folder));
  if (!file) {
    console.error(`focus failed for ${folder}: no file found to open`);
    return;
  }
  execFile("open", ["-a", app, file], (err, _stdout, stderr) => {
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
  let real = sessions.filter((s) => !s.nested);
  let nested = sessions.filter((s) => s.nested);

  // A session that has ever reported a non-nested cwd stays real, even once
  // its cwd moves into a worktree. `nested` is really a property of where a
  // session *started*: one that runs EnterWorktree mid-task looks identical
  // to a background checkout from the cwd alone, and demoting it blanks out a
  // busy green key in the middle of the work it's reporting on. Same
  // first-seen rule as everything else here — only a session already nested
  // the first time it appeared becomes an indicator.
  //
  // Deliberately not `sessionOrder.has()`: an orphan-promoted stand-in (see
  // below) is in there too, and those must still revert once a genuine real
  // session shows up for their folder.
  for (const s of real) everReal.add(s.session_id);
  const settled = nested.filter((s) => everReal.has(s.session_id));
  if (settled.length) {
    real = [...real, ...settled];
    nested = nested.filter((s) => !everReal.has(s.session_id));
  }

  // A folder with no real session at all would otherwise vanish from the
  // board entirely — no primary button to attach its nested sessions to.
  // The common cause is an interactive session that simply cd'd into a
  // worktree rather than a background helper spawned by one; there's no way
  // to tell those apart from the data available, so the earliest-seen
  // nested session for such a folder is promoted to stand in as its
  // primary, rather than losing the folder's only button.
  const realFolders = new Set(real.map((s) => s.folder));
  const orphanFolders = new Set(nested.map((s) => s.folder).filter((f) => !realFolders.has(f)));
  for (const folder of orphanFolders) {
    const candidates = nested
      .filter((s) => s.folder === folder)
      .sort((a, b) => (nestedOrder.get(a.session_id) ?? Infinity) - (nestedOrder.get(b.session_id) ?? Infinity));
    const promoted = candidates[0];
    real = [...real, promoted];
    nested = nested.filter((s) => s.session_id !== promoted.session_id);
  }

  const liveFolders = new Set(real.map((s) => s.folder));
  for (const s of real) {
    if (!folderOrder.has(s.folder)) folderOrder.set(s.folder, folderOrder.size);
    if (!folderAccent.has(s.folder)) folderAccent.set(s.folder, claimAccent(s.folder, liveFolders));
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
      folderOrder.get(a.folder) - folderOrder.get(b.folder) ||
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
    const isPrimary = i === 0 || visible[i - 1].folder !== s.folder;
    if (isPrimary) {
      nestedBySlot[i] = nested
        .filter((n) => n.folder === s.folder)
        .sort((a, b) => nestedOrder.get(a.session_id) - nestedOrder.get(b.session_id));
    }
  });
}

// The three things every board derives from a session the same way. One copy
// rather than one per view: the fallback chain and the clearedEmpty rule
// below are invariants (see CLAUDE.md), and the second copy had already
// dropped a field the first one drew.
//
// `projectPath` is the folder whose basename names the key — the matched VS
// Code window normally, but a worktree session's own cwd on the detail board,
// where the parent project's name is already on screen.
function keyFields(session, projectPath = session.folder) {
  return {
    // Prefer the AI-generated title (the exact string VS Code's terminal list
    // shows), then Claude Code's short session name, then the cwd's basename —
    // each a fallback for when the one before it isn't available yet (e.g.
    // aiTitle hasn't been generated this early in a session) or a future
    // Claude Code version changes format.
    //
    // clearedEmpty skips that whole chain: /clear reuses the transcript file,
    // so a title found there would be the pre-clear one, and name/cwd would
    // look like a real answer when the honest one is "nothing yet".
    label: session.clearedEmpty
      ? ""
      : session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd,
    project: projectPath.split("/").filter(Boolean).pop() ?? "",
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
export function detailLayout({ session, tasks, nested, age, slotCount }) {
  // Same title as the session's own key, clearedEmpty rule included — after a
  // /clear the two header keys go blank rather than showing the session name
  // as though it were an answer.
  const [titleA, titleB] = splitLabel(keyFields(session).label, 2);
  const header = [
    { kind: "label", label: titleA },
    { kind: "label", label: titleB },
    { kind: "stat", label: "STATE", value: age ? `${session.state} ${age}` : session.state },
    { kind: "stat", label: "CONTEXT", value: typeof session.context === "number" ? `${session.context}%` : "—" },
    {
      kind: "stat",
      label: "MODEL",
      // "claude-opus-5" is three quarters vendor on a 72px key.
      value: [(session.model ?? "").replace(/^claude-/, ""), session.effort ?? ""].filter(Boolean).join(" ") || "—",
    },
  ];

  const nestedTiles = nested.slice(0, Math.max(0, slotCount - header.length)).map((s) => ({ kind: "nested", session: s }));
  const taskRoom = slotCount - header.length - nestedTiles.length;
  const shown = taskWindow(tasks, taskRoom);
  const taskTiles = shown.map((t) => ({
    kind: "task",
    number: tasks.indexOf(t) + 1,
    subject: t.subject ?? "",
    status: t.status ?? "pending",
  }));

  const body = new Array(taskRoom).fill(null);
  taskTiles.forEach((tile, i) => (body[i] = tile));
  return [...header, ...body, ...nestedTiles];
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
      await deck.fillKeyBuffer(btn.index, await renderStat({ ...btn, ...stat }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// The attention board: the queue across the session keys, re-ranked every
// poll. Unlike the detail view this deliberately re-sorts while it's up — a
// session that gets unblocked should leave the queue you're looking at.
async function refreshAttention(deck, buttons, attentionButton) {
  const sessions = await getLiveSessions();
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
      const { label, project, age } = keyFields(session);
      const accent = accentFor(session.folder);

      // One object drives both the render call and the drawn signature (the
      // shape refreshDetail set and refresh() now also follows) so a field
      // drawn but not signed can't happen — that's what left this same
      // tile's gauge frozen once already, and dropped its task counter a
      // second time.
      const params = { state: session.state, label, accent, project, context: session.context, age, progress: session.progress };
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

async function refresh(deck, buttons, slots, nestedBySlot) {
  const sessions = await getLiveSessions();
  assignSlots(sessions, slots, nestedBySlot);
  const byId = new Map(sessions.map((s) => [s.session_id, s]));

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
      const { label, project, age } = keyFields(session);
      const accent = accentFor(session.folder);
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
      const params = { state, shell: session.state === "shell", label, accent, project, progress: session.progress, context: session.context, nestedStates, age };
      btn.renderParams = params;

      // Skip the re-encode when nothing visible changed — most polls are
      // no-ops once a board has settled.
      const drawn = `session ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(btn.index, await renderKey({ ...btn, ...params }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
  return sessions;
}

// The detail board: one session across every session key — a two-key title,
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
  const sessions = await getLiveSessions();
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

  // Sessions already holding a board key of their own (everReal — a real
  // session that later cd'd into a worktree, or this session itself) are not
  // worktree children of this one.
  const nested = sessions.filter(
    (s) => s.nested && s.folder === session.folder && s.session_id !== session.session_id && !everReal.has(s.session_id)
  );
  const tasks = await readTaskList(session.session_id);
  const { age } = keyFields(session);
  const fresh = detailLayout({ session, tasks, nested, age, slotCount: buttons.length });
  view.tiles ??= fresh;
  const tiles = holdTiles(view.tiles, fresh, tasks, sessions);
  const accent = accentFor(session.folder);

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
        tile.kind === "task"
          ? { number: tile.number, subject: tile.subject, status: tile.status }
          : tile.kind === "stat"
          ? { label: tile.label, value: tile.value }
          : tile.kind === "nested"
          ? {
              state: tile.session.state,
              accent,
              // A worktree tile names its own checkout, not the parent
              // project whose name is already two keys up.
              ...keyFields(tile.session, tile.session.cwd),
              progress: tile.session.progress,
              context: tile.session.context,
            }
          : { state: session.state, label: tile.label, accent, project: "" };
      const drawn = `detail ${tile.kind} ${JSON.stringify(params)}`;
      if (btn.drawn === drawn) return;

      const render = tile.kind === "task" ? renderTask : tile.kind === "stat" ? renderStat : renderKey;
      await deck.fillKeyBuffer(btn.index, await render({ ...btn, ...params }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
  // Returned so the poll loop can hand the same read to drawAttention rather
  // than calling getLiveSessions() a second time for the same 2s tick.
  return sessions;
}

// Flashes every requires_action key between its normal red and a brighter
// red — the one state that's actually blocked on you, so the one worth
// catching your eye. The attention key joins the same beat, and only when
// its cached count is nonzero — a CLEAR key stays dark and still. Runs on
// its own faster tick alongside the main poll rather than inside it:
// `refresh` only redraws on change, but a pulse must redraw on a fixed beat
// regardless. `btn.drawn` is left alone so the next `refresh`/`drawAttention`
// still recognises a steady frame as unchanged.
async function pulse(deck, buttons, attentionButton, isOverlayView, isDisconnected) {
  let bright = false;
  while (!isDisconnected()) {
    bright = !bright;
    if (!isOverlayView()) {
      try {
        await Promise.all([
          ...buttons
            .filter((btn) => btn.renderParams?.state === "requires_action" || (btn.renderParams?.nestedStates?.length ?? 0) > 0)
            .map(async (btn) => {
              const buf = await renderKey({ ...btn, ...btn.renderParams, pulse: bright });
              await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
            }),
          ...(attentionButton.renderParams?.count > 0
            ? [
                (async () => {
                  const buf = await renderAttention({ ...attentionButton, ...attentionButton.renderParams, pulse: bright });
                  await deck.fillKeyBuffer(attentionButton.index, buf, { format: "rgba" });
                })(),
              ]
            : []),
        ]);
      } catch (err) {
        console.error("pulse failed:", err.message);
      }
    }
    await new Promise((r) => setTimeout(r, PULSE_MS));
  }
}

async function run() {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new Error("No Stream Deck found. Is it plugged in?");
  }
  const deck = await openStreamDeck(devices[0].path);
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
  // what it did — this is what makes a second press on the same button mean
  // "again", and any other key in between break that chain.
  let lastPress = null;
  // Every view change goes through here so the attention key can't stick on
  // a bright pulse frame: pulse() writes without touching btn.drawn, so if the
  // view flips away from "sessions" mid-pulse the attention key can freeze on
  // whichever frame it was mid-write, and its own signature never changes to
  // force a repaint. Nulling attentionButton.drawn on every transition costs
  // one redundant redraw at worst and guarantees the next drawAttention call
  // repaints it for real.
  const setView = (next) => {
    view = next;
    attentionButton.drawn = null;
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
    const press = { index: control.index, session_id: sessionId };

    // Any press leaves an overlay, including the key that opened it.
    if (view.kind === "attention" || view.kind === "detail") {
      const wasAttention = view.kind === "attention";
      setView({ kind: "sessions" });
      // In the queue a session key still focuses its window on the way out —
      // that's the whole point of pressing one there.
      if (wasAttention && btn?.assigned) focusWindow(btn.assigned.folder, btn.assigned.ide);
      lastPress = press;
      return;
    }
    if (isUsage) {
      setView(view.kind === "stats" ? { kind: "sessions" } : { kind: "stats" });
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (isAttention) {
      // Dark key, nothing queued: a press has nothing to show, so it does
      // nothing rather than opening an empty board. `attentionCount` is what
      // the last drawAttention() returned.
      if (attentionCount > 0) setView({ kind: "attention" });
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (view.kind === "stats") {
      lastPress = press;
      return; // stat tiles aren't clickable
    }

    // A second press on the same key for the same session opens that
    // session's detail board; the first still focuses its window. "Second"
    // means the immediately preceding press, not a press within some timeout,
    // so any other key in between breaks the chain.
    const isRepeat = sessionId !== null && lastPress?.index === control.index && lastPress?.session_id === sessionId;
    if (isRepeat) {
      setView({ kind: "detail", session_id: sessionId });
      // Without this, the button that opened the detail board keeps reporting
      // its old session_id (refreshDetail only nulls it on its first poll,
      // up to 2s later) — so the *next* press, which is meant to just dismiss
      // the overlay, still looks like "same key, same session" and the press
      // after that reads as another repeat, reopening detail instead of
      // focusing the window. Nulling it here makes the outcome depend on what
      // was pressed, not on how fast.
      btn.assigned = null;
    } else if (btn?.assigned) {
      focusWindow(btn.assigned.folder, btn.assigned.ide);
    }
    lastPress = press;
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
        await refreshStats(deck, buttons, [...resetTiles, ...(await getStats())]);
        attentionCount = await drawAttention(deck, attentionButton, await getLiveSessions(), false);
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
        const detailSessions = await refreshDetail(deck, buttons, view);
        // Same race guard as the attention branch above: only leave the
        // board this tick was actually drawing.
        if (detailSessions === null && view.kind === "detail") {
          // The session ended mid-visit; refreshDetail already blanked every
          // tile and nulled renderParams. Leave the board rather than sit on
          // it forever, repainting the same tick for the same reason.
          setView({ kind: "sessions" });
          const sessions = await refresh(deck, buttons, slots, nestedBySlot);
          attentionCount = await drawAttention(deck, attentionButton, sessions, false);
        } else if (detailSessions !== null) {
          attentionCount = await drawAttention(deck, attentionButton, detailSessions, false);
        }
      } else {
        const sessions = await refresh(deck, buttons, slots, nestedBySlot);
        attentionCount = await drawAttention(deck, attentionButton, sessions, false);
      }
      await drawUsage(deck, usageButton);
    } catch (err) {
      console.error("refresh failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await deck.close().catch(() => {});
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
