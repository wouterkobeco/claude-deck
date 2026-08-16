import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./sessions.mjs";

const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");

/**
 * What each open VS Code window can see, published by the extension: the
 * folders it has open, whether it's the focused window, and which session's
 * terminal is currently in front.
 *
 * This is the reverse of `terminal-focus.mjs` — the daemon asks for a terminal
 * there, and learns what actually happened here. The original design
 * deliberately had no reply channel, on the grounds that nothing consumed one;
 * the repeat-press rule now does, because "did this press change anything" is
 * only knowable inside the editor.
 *
 * **Synchronous on purpose.** The only caller is `deck.on("down")`, which is a
 * synchronous handler — an async read would resolve after the press was already
 * decided. These are a handful of ~80-byte files.
 *
 * **The filename is the liveness handle.** Each file is named for its extension
 * host's own pid, so a window that has gone away is detected exactly, with
 * `process.kill(pid, 0)`. The alternative was a timestamp plus a heartbeat
 * write, which would mean six open windows rewriting a file every 400ms
 * forever to say nothing changed.
 *
 * Every failure is skipped rather than thrown, same rule as `vscode-state.mjs`:
 * these files are written by another process and a read can land mid-write. A
 * missing directory just means the extension has never run.
 */
export function readWindowStates(dir = WINDOWS_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no directory — the extension has never run on this machine
  }

  const states = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -".json".length));
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, name), "utf8"));
      // Without `folders` there is no way to say which window this is, which
      // is the one thing the caller needs it for.
      if (!Array.isArray(state.folders)) continue;
      states.push({
        pid,
        folders: state.folders,
        focused: state.focused === true,
        activeSessionId: state.activeSessionId ?? null,
      });
    } catch {
      // mid-write or corrupt — skip this window, not the whole read
    }
  }
  return states;
}

const IDE_DIR = join(homedir(), ".claude", "ide");

/**
 * How many VS Code windows are open, from the IDE locks Claude Code writes.
 *
 * Only used for the "N of M windows have the extension" line the daemon logs:
 * the extension takes effect in a window only after that window has been
 * reloaded, and a window that silently behaves like the old build is the one
 * failure this feature reliably produces. Comparing this against
 * `readWindowStates().length` is the whole diagnostic.
 *
 * JetBrains writes the same lock shape with its own `ideName` and can never run
 * this extension, so counting it would permanently overstate the denominator
 * and make a fully-reloaded machine still look incomplete. A lock with no
 * `ideName` counts as VS Code — that's the same normalisation `focusWindow`
 * already applies, and it's the common case.
 */
export function countVsCodeWindows(dir = IDE_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    try {
      const { ideName } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if ((ideName ?? "Visual Studio Code") === "Visual Studio Code") count++;
    } catch {
      // mid-write or corrupt — not countable
    }
  }
  return count;
}
