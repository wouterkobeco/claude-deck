/**
 * The one thing the daemon knows that a VS Code window cannot work out for
 * itself: which Claude Code sessions are open in it, on this machine or on a
 * remote host.
 *
 * The extension needs that list to offer "restore my sessions" after VS Code
 * has been quit and restarted — the registry entries are gone by then, because
 * Claude Code removes its own on exit, so the list has to be captured while the
 * sessions are still alive and kept in the window's own storage.
 *
 * Two things stop the extension from reading `~/.claude/sessions` itself. A
 * remote window's sessions are on the *other* machine, and only the daemon has
 * fetched them (`remote-fs.mjs`); and matching a session to a window is
 * `matchFolder`'s rule plus the IDE locks, which `sessions.mjs` has already
 * done by the time the board is drawn. So the daemon publishes the answer and
 * the extension does nothing but filter it to its own folders.
 *
 * This is the second file the daemon writes (the first is the terminal-focus
 * request). Same shape of thing: one file, rewritten in place, no reader
 * addressing — every window reads it and keeps the rows that are its own.
 */

import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_FILE = join(homedir(), ".claude", "streamdeck-sessions.json");

// Last JSON written. Nothing here changes on most polls — a session list is
// stable for minutes at a time — and this runs every 2s.
let lastRaw = null;

/**
 * The published rows. Pure and exported for the check: what the extension can
 * see is exactly this, so a field dropped here is a field it cannot recover.
 *
 * Nested sessions are left out. An Agent-tool subagent has no session of its
 * own to resume (it lives inside its parent's process) and an SDK session was
 * started by a script rather than by a person — restoring either would be
 * restoring something nobody opened.
 */
export function sessionRows(sessions) {
  return sessions
    .filter((s) => !s.nested)
    .map((s) => ({
      id: s.session_id,
      cwd: s.cwd,
      // The window matches on these two, not on cwd: a worktree's cwd sits
      // under the folder rather than at it, and one path can exist on two
      // hosts. `folderKeyFor`'s reasoning, one process over.
      folder: s.folder,
      host: s.host ?? null,
      // What the key shows, minus the "nothing yet" cases — a restore picker
      // wants a name for a session that has never been typed into just as much
      // as for one that has, and falls back to the cwd's basename itself.
      title: s.aiTitle ?? s.name ?? null,
    }));
}

/**
 * Best-effort, like every other file this project touches: a window that finds
 * no list simply offers no restore.
 *
 * Written to a temp file and renamed for the same reason `requestFocus` does —
 * the reader polls on its own clock and would otherwise eventually catch a
 * half-written file.
 */
export async function publishSessions(sessions) {
  let raw;
  try {
    raw = JSON.stringify(sessionRows(sessions));
  } catch {
    return;
  }
  if (raw === lastRaw) return;
  const tmp = `${SESSIONS_FILE}.tmp`;
  try {
    await writeFile(tmp, raw);
    await rename(tmp, SESSIONS_FILE);
    // Set only after the rename, so a failed write is retried next poll rather
    // than remembered as done.
    lastRaw = raw;
  } catch {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * The published ids, in the order they were published.
 *
 * The daemon's own message read back by the next run of the daemon, which is a
 * second job for this file rather than a seventh file: it already holds
 * exactly the non-nested sessions, and the board's ordering is over exactly
 * those. `index.mjs` writes it in board order for this reason — the order was
 * arbitrary before and nothing read it.
 *
 * What it buys: `sessionOrder` is first-seen for the daemon's lifetime, so a
 * restart used to rebuild it from `readdir` order and shuffle every session
 * within its project's block — the one piece of the board's identity that did
 * not survive, now that accents, project order and the board's own address all
 * do. Seeding from here means a session keeps its key across a restart.
 *
 * Best-effort like everything else here: no file, a half-written one, or a
 * hand-edited one is a first run. Ids are checked to be strings because they
 * become map keys and then reach `claude --resume` through the extension —
 * the same reason `readAccents` refuses a non-string colour.
 */
export function readPublishedIds(file = SESSIONS_FILE) {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => r?.id).filter((id) => typeof id === "string" && id);
  } catch {
    return [];
  }
}
