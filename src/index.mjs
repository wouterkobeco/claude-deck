import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import { getLiveSessions } from "./sessions.mjs";
import { openFileIn } from "./vscode-state.mjs";
import { renderKey, renderBlank, renderUsage, renderStat } from "./render.mjs";
import { getUsage, daysUntil, hoursUntil } from "./usage.mjs";
import { getStats } from "./stats.mjs";

const POLL_MS = 2000;
const RECONNECT_MS = 5000;
// ~2.5fps: fast enough to read as a pulse, slow enough not to flood the deck's
// USB HID link across up to 14 keys at once.
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
let arrivals = 0;

export function accentFor(folder) {
  return ACCENTS[(folderOrder.get(folder) ?? 0) % ACCENTS.length];
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
async function focusWindow(folder) {
  const file = (await openFileIn(folder)) ?? (await anchorFile(folder));
  if (!file) {
    console.error(`focus failed for ${folder}: no file found to open`);
    return;
  }
  execFile("open", ["-a", "Visual Studio Code", file], (err, _stdout, stderr) => {
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
  const real = sessions.filter((s) => !s.nested);
  const nested = sessions.filter((s) => s.nested);

  for (const s of real) {
    if (!folderOrder.has(s.folder)) folderOrder.set(s.folder, folderOrder.size);
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

// The bottom-right key is the usage readout rather than a session, so it is
// left out of `buttons` before slots are assigned.
async function drawUsage(deck, btn) {
  const { session, week } = await getUsage();
  const drawn = `usage ${session} ${week}`;
  if (btn.drawn === drawn) return;
  await deck.fillKeyBuffer(btn.index, await renderUsage({ ...btn, session, week }), { format: "rgba" });
  btn.drawn = drawn;
}

// Stats view: the same 14 buttons, repurposed as an all-time stats board.
// Reuses the `drawn`-signature diffing that `refresh` uses for sessions, so
// switching modes just redraws everything once (the signatures never match
// across modes) and needs no explicit invalidation.
async function refreshStats(deck, buttons, stats) {
  await Promise.all(
    buttons.map(async (btn, i) => {
      const stat = stats[i] ?? null;
      btn.assigned = null;

      if (!stat) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      const drawn = `stat ${stat.label} ${stat.value}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(btn.index, await renderStat({ ...btn, ...stat }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
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
      // Prefer the AI-generated title (the exact string VS Code's terminal
      // list shows), then Claude Code's short session name, then the cwd's
      // basename — each a fallback for when the one before it isn't
      // available yet (e.g. aiTitle hasn't been generated this early in a
      // session) or a future Claude Code version changes format.
      //
      // clearedEmpty skips that whole chain: /clear reuses the transcript
      // file, so a title found there would be the pre-clear one, and name/cwd
      // would look like a real answer when the honest one is "nothing yet".
      const label = session.clearedEmpty
        ? ""
        : session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;

      const accent = accentFor(session.folder);
      const project = session.folder.split("/").filter(Boolean).pop() ?? "";
      const progress = session.progress;
      const nestedCount = btn.nestedSessions.length;
      // Cached every poll (not just on change) so the pulse loop below can
      // redraw a requires_action key between polls without re-deriving it
      // from a fresh getLiveSessions() call.
      btn.renderParams = { state: session.state, label, accent, project, progress, context: session.context, nestedCount };

      // Skip the re-encode when nothing visible changed — most polls are
      // no-ops once a board has settled.
      const drawn = `${session.state} ${accent} ${project} ${progress?.current}/${progress?.total} ${session.context} ${label} ${nestedCount}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(btn.index, await renderKey({ ...btn, ...btn.renderParams }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// The nested-session overlay: same rendering and blank/diffing conventions
// as refresh(), but drawn from a fixed set of session ids captured once at
// the moment the overlay opened (nestedView.order) rather than a fresh
// assignSlots pass — order stays put for the visit even as content updates.
async function refreshNested(deck, buttons, nestedView) {
  const sessions = await getLiveSessions();
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const accent = accentFor(nestedView.folder);

  await Promise.all(
    buttons.map(async (btn, i) => {
      const sessionId = nestedView.order[i];
      const session = sessionId ? byId.get(sessionId) : null;
      btn.assigned = null; // nested tiles have no window to focus
      // pulse() is paused while the overlay shows (see the run() change
      // below), but the instant it's dismissed, pulse resumes on its own
      // 400ms tick and reads whatever btn.renderParams already holds —
      // which, without this, would still be each button's pre-overlay data,
      // stale by however long the overlay was open. Nulling it here means
      // pulse's filter (state/nestedCount) finds nothing to redraw until the
      // next refresh() repopulates it, at most 2s later.
      btn.renderParams = null;

      if (!session) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      const label = session.clearedEmpty
        ? ""
        : session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
      const project = session.cwd.split("/").filter(Boolean).pop() ?? "";
      const progress = session.progress;

      const drawn = `nested ${session.state} ${project} ${progress?.current}/${progress?.total} ${session.context} ${label}`;
      if (btn.drawn === drawn) return;
      const buf = await renderKey({ ...btn, state: session.state, label, accent, project, progress, context: session.context });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}

// Flashes every requires_action key between its normal red and a brighter
// red — the one state that's actually blocked on you, so the one worth
// catching your eye. Runs on its own faster tick alongside the main poll
// rather than inside it: `refresh` only redraws on change, but a pulse must
// redraw on a fixed beat regardless. `btn.drawn` is left alone so the next
// `refresh` still recognises a steady frame as unchanged.
async function pulse(deck, buttons, isStatsMode, isDisconnected) {
  let bright = false;
  while (!isDisconnected()) {
    bright = !bright;
    if (!isStatsMode()) {
      try {
        await Promise.all(
          buttons
            .filter((btn) => btn.renderParams?.state === "requires_action" || (btn.renderParams?.nestedCount ?? 0) > 0)
            .map(async (btn) => {
              const buf = await renderKey({ ...btn, ...btn.renderParams, pulse: bright });
              await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
            })
        );
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
  console.log(`Connected to ${deck.PRODUCT_NAME}`);

  const allButtons = deck.CONTROLS.filter((c) => c.type === "button")
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      index: c.index,
      width: c.pixelSize.width,
      height: c.pixelSize.height,
      assigned: null,
      drawn: null,
    }));
  // Keys are row-major, so the highest index is the bottom-right one.
  const usageButton = allButtons.pop();
  const buttons = allButtons;
  const slots = new Array(buttons.length).fill(null);
  const nestedBySlot = new Array(buttons.length).fill(null);

  let disconnected = false;
  // Toggled by pressing the usage key; the key itself keeps rendering the
  // same either way — it's the 14 session buttons that switch content.
  let statsMode = false;
  // { folder, order: [session_id, ...] } while the nested-session overlay is
  // showing, otherwise null. `order` is captured once when the overlay opens
  // and never re-sorted — see refreshNested.
  let nestedView = null;
  // The immediately preceding key-down, updated on every press regardless of
  // what it did — this is what makes a second press on the same button mean
  // "again", and any other key in between break that chain.
  let lastPress = null;
  deck.on("error", (err) => {
    console.error("Stream Deck error:", err);
    disconnected = true;
  });
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const btn = control.index === usageButton.index ? null : buttons[control.index];
    const sessionId = btn?.assigned?.session_id ?? null;

    if (nestedView) {
      nestedView = null;
      lastPress = { index: control.index, session_id: sessionId };
      return;
    }
    if (control.index === usageButton.index) {
      statsMode = !statsMode;
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (statsMode) {
      lastPress = { index: control.index, session_id: sessionId };
      return; // stat tiles aren't clickable
    }

    const isRepeat = sessionId !== null && lastPress?.index === control.index && lastPress?.session_id === sessionId;
    if (isRepeat && btn.nestedSessions?.length) {
      nestedView = { folder: btn.assigned.folder, order: btn.nestedSessions.map((s) => s.session_id) };
    } else if (btn?.assigned) {
      focusWindow(btn.assigned.folder);
    }
    lastPress = { index: control.index, session_id: sessionId };
  });

  // Runs alongside the poll loop below, not inside it — it needs a much
  // faster beat than the 2s poll to read as a pulse.
  pulse(deck, buttons, () => statsMode || !!nestedView, () => disconnected);

  while (!disconnected) {
    try {
      if (statsMode) {
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
      } else if (nestedView) {
        await refreshNested(deck, buttons, nestedView);
      } else {
        await refresh(deck, buttons, slots, nestedBySlot);
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
