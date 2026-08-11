import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import { getLiveSessions } from "./sessions.mjs";
import { openFileIn } from "./vscode-state.mjs";
import { renderKey, renderBlank } from "./render.mjs";

const POLL_MS = 2000;
const RECONNECT_MS = 5000;
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
export function assignSlots(sessions, slots) {
  for (const s of sessions) {
    if (!folderOrder.has(s.folder)) folderOrder.set(s.folder, folderOrder.size);
    if (!sessionOrder.has(s.session_id)) sessionOrder.set(s.session_id, arrivals++);
  }

  const live = new Set(sessions.map((s) => s.session_id));
  for (const id of [...sessionOrder.keys()]) {
    if (!live.has(id)) sessionOrder.delete(id);
  }

  const ordered = [...sessions].sort(
    (a, b) =>
      folderOrder.get(a.folder) - folderOrder.get(b.folder) ||
      sessionOrder.get(a.session_id) - sessionOrder.get(b.session_id)
  );

  slots.fill(null);
  ordered.slice(0, slots.length).forEach((s, i) => {
    slots[i] = s.session_id;
  });
}

async function refresh(deck, buttons, slots) {
  const sessions = await getLiveSessions();
  assignSlots(sessions, slots);
  const byId = new Map(sessions.map((s) => [s.session_id, s]));

  await Promise.all(
    buttons.map(async (btn, slot) => {
      const session = slots[slot] ? byId.get(slots[slot]) : null;
      btn.assigned = session ?? null;

      if (!session) {
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
      const label = session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;

      // Skip the re-encode when nothing visible changed — most polls are
      // no-ops once a board has settled.
      const accent = accentFor(session.folder);
      const progress = session.progress;
      const drawn = `${session.state} ${accent} ${progress?.done}/${progress?.total} ${label}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(
        btn.index,
        await renderKey({ ...btn, state: session.state, label, accent, progress }),
        { format: "rgba" }
      );
      btn.drawn = drawn;
    })
  );
}

async function run() {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new Error("No Stream Deck found. Is it plugged in?");
  }
  const deck = await openStreamDeck(devices[0].path);
  console.log(`Connected to ${deck.PRODUCT_NAME}`);

  const buttons = deck.CONTROLS.filter((c) => c.type === "button").map((c) => ({
    index: c.index,
    width: c.pixelSize.width,
    height: c.pixelSize.height,
    assigned: null,
    drawn: null,
  }));
  const slots = new Array(buttons.length).fill(null);

  let disconnected = false;
  deck.on("error", (err) => {
    console.error("Stream Deck error:", err);
    disconnected = true;
  });
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const btn = buttons[control.index];
    if (btn?.assigned) focusWindow(btn.assigned.folder);
  });

  while (!disconnected) {
    try {
      await refresh(deck, buttons, slots);
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
