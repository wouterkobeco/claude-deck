import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./sessions.mjs";

const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");

/**
 * A host string safe to hand to `ssh` as an argument.
 *
 * Every other field this file returns is consumed as data — `folders` is
 * checked for being strings only because a non-string would throw inside
 * `folder.endsWith`, in a synchronous press handler. `host` is different in
 * kind: it is *executed*. A value beginning with `-` is taken by `ssh` as an
 * option, so `-oProxyCommand=…` would run a command on this machine, and
 * `execFile` does not help because the parsing is ssh's own. The daemon also
 * passes it after `--`; this is the other half of that pair.
 *
 * Deliberately narrower than the set of legal hostnames. A host this rejects
 * is a host you can add to `~/.ssh/config` under a plain alias.
 */
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validHost(value) {
  return typeof value === "string" && HOST_RE.test(value) ? value : null;
}

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
      // is the one thing the caller needs it for. Every element must also be
      // a string: the only writer is the extension's own
      // `workspaceFolders.map((f) => f.uri.fsPath)`, so a non-string entry has
      // no known producer — but this file lands inside `deck.on("down")` via
      // `isRepeatPress` -> `matchFolder` -> `isUnder` -> `folder.endsWith`,
      // a synchronous handler nothing may throw inside, and cheap insurance
      // against a `TypeError` there beats a dark deck while a producer gets
      // found.
      if (!Array.isArray(state.folders) || !state.folders.every((f) => typeof f === "string")) continue;
      states.push({
        pid,
        folders: state.folders,
        focused: state.focused === true,
        activeSessionId: state.activeSessionId ?? null,
        host: validHost(state.host),
      });
    } catch {
      // mid-write or corrupt — skip this window, not the whole read
    }
  }
  return states;
}

const IDE_DIR = join(homedir(), ".claude", "ide");

// Every VS Code IDE lock in `dir`, as its list of workspace folders.
//
// JetBrains writes the same lock shape with its own `ideName` and can never run
// this extension, so it is filtered out here rather than by every caller: left
// in, it would permanently overstate the denominator and make a fully-reloaded
// machine still look incomplete. A lock with no `ideName` counts as VS Code —
// the same normalisation `focusWindow` already applies, and the common case.
function readIdeLocks(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const locks = [];
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    try {
      const { ideName, workspaceFolders } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if ((ideName ?? "Visual Studio Code") !== "Visual Studio Code") continue;
      locks.push(Array.isArray(workspaceFolders) ? workspaceFolders.filter((f) => typeof f === "string") : []);
    } catch {
      // mid-write or corrupt — not countable
    }
  }
  return locks;
}

/**
 * How many VS Code windows are open, from the IDE locks Claude Code writes.
 *
 * Only used for the "N of M windows have the extension" line the daemon logs:
 * the extension takes effect in a window only after that window has been
 * reloaded, and a window that silently behaves like the old build is the one
 * failure this feature reliably produces. Comparing this against
 * `readWindowStates().length` is the whole diagnostic.
 *
 * A remote window's IDE lock lives on the remote host, not in `dir` — so it is
 * missing from the count above while its published state (`states`, what
 * `readWindowStates` already read this poll) is present in the numerator.
 * Counting it here keeps both sides describing the same population. `pid` is
 * the same key `readWindowStates` already uses per window (the extension host
 * always runs locally, even against a remote SSH folder — see `extensionKind`
 * in extension/), so the `Set` is one entry per open window, matching what the
 * numerator counts a remote window as.
 */
export function countVsCodeWindows(dir = IDE_DIR, states = []) {
  return readIdeLocks(dir).length + new Set(states.filter((s) => s.host).map((s) => s.pid)).size;
}

/**
 * Which windows are the ones still to reload, named by the folders they hold.
 *
 * "4 of 5 windows have the extension" tells you to go reload something and not
 * which something, on a machine with five windows open. This is the same
 * comparison, kept as a difference rather than collapsed to two integers.
 *
 * **The join can only be on folders.** Every IDE lock on this machine reports
 * the same `pid` — VS Code's *main* process, shared by every window — and the
 * lock's filename is its websocket port, so there is no per-window identity on
 * that side to match against the extension-host pid this file is otherwise
 * keyed by. Windows are therefore compared by their folder list, sorted and
 * joined so a multi-root window is one key rather than several.
 *
 * That leaves one thing it cannot resolve, and it says so rather than guessing:
 * two windows open on the *same* folder are indistinguishable here, so the
 * answer is a count — "1 of 2 windows" — not a pointer at one of them. That is
 * live on this machine (two locks on `kob/kob-backend`) and is the same
 * duplicate-folder ambiguity `focusWindow` has never been able to solve either.
 *
 * Remote windows are left out of both sides: their IDE lock lives on the other
 * host so it is never in `dir`, and their published state is the only reason
 * they are counted at all — so they can never be the stale ones. Comparing
 * only `host === null` states keeps a remote folder path from coincidentally
 * matching a local one.
 */
export function staleWindows(dir = IDE_DIR, states = []) {
  const key = (folders) => [...folders].sort().join("\n");
  const have = new Map();
  for (const s of states) {
    if (s.host) continue;
    const k = key(s.folders);
    have.set(k, (have.get(k) ?? 0) + 1);
  }

  const stale = [];
  const open = new Map();
  for (const folders of readIdeLocks(dir)) {
    const k = key(folders);
    open.set(k, (open.get(k) ?? 0) + 1);
  }
  for (const [k, total] of open) {
    const covered = have.get(k) ?? 0;
    if (covered >= total) continue;
    const folders = k ? k.split("\n") : [];
    stale.push({
      // The basename is what anyone reading a log line recognises; the full
      // paths ride along for a caller that wants to be precise.
      name: folders.map((f) => f.split("/").filter(Boolean).pop() ?? f).join(" + ") || "(no folder)",
      folders,
      open: total,
      covered,
    });
  }
  return stale.sort((a, b) => a.name.localeCompare(b.name));
}
