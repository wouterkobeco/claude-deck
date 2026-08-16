/**
 * The daemon half of terminal focus: work out which terminal a session is
 * running in, and ask for it.
 *
 * The join is process ancestry. `Terminal.processId` in the VS Code extension
 * API is the shell's pid; the session registry gives Claude's pid; Claude is a
 * descendant of that shell:
 *
 *   99684 claude  <-  92021 zsh  <-  2433 ptyHost  <-  1316 Code
 *
 * So the daemon sends the whole chain and the extension picks the terminal
 * whose processId is in it. Nothing here assumes a depth, a shell, or a
 * wrapper — the alternative, matching `Terminal.name`, tracks the terminal's
 * creation name rather than the OSC title Claude sets, and would break the
 * moment a terminal is renamed.
 */

import { execFile } from "node:child_process";
import { rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");

// Press order, captured synchronously at every call. See requestFocus.
let issued = 0;

/**
 * Every pid from `pid` up to (but not including) pid 1.
 *
 * Pure, and exported for the check, because this is the piece where being
 * subtly wrong is invisible: an off-by-one that drops the shell's own pid
 * matches nothing, and looks identical to "the extension isn't installed".
 *
 * Stops on three things: reaching pid 1 (whose inclusion would match every
 * terminal, since it is every process's ancestor), a pid the table doesn't
 * know (the process exited between the registry read and the `ps` call), and
 * a pid already seen. That last one can't happen with a real process table —
 * which is why it's guarded rather than assumed, along with `maxDepth` behind
 * it. A daemon that hangs on a press is worse than one that focuses nothing.
 */
export function ancestorChain(pid, ppidByPid, maxDepth = 20) {
  const chain = [];
  let current = pid;
  while (chain.length < maxDepth && current > 1 && !chain.includes(current)) {
    chain.push(current);
    const parent = ppidByPid.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return chain;
}

/**
 * `ps -Ao pid,ppid` output as pid -> ppid. The columns are right-aligned, so
 * every line has leading whitespace and a plain `split(" ")` would produce
 * empty fields; the first line is a header and the last is empty. Anything
 * that doesn't parse as two integers is skipped rather than stored as NaN.
 */
export function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of stdout.split("\n").slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
  }
  return table;
}

async function psTable() {
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid"], { maxBuffer: 8 * 1024 * 1024 });
  return parseProcessTable(stdout);
}

/**
 * Ask whichever VS Code window owns this session's terminal to reveal it.
 *
 * Self-routing: one file, read by every window's extension, acted on by the
 * single one that finds a matching `Terminal.processId`. The alternative — a
 * port file per window plus an HTTP POST — buys a delivery confirmation the
 * deck has nowhere to display, in exchange for three more ways to address the
 * wrong window.
 *
 * `issued` is the fix for a real race, not a theoretical one. This is fired
 * without `await` from the press handler and spawns a process before it
 * writes, so two presses 400ms apart can have their `ps` calls complete out of
 * order — and the *earlier* press would land last, revealing the terminal you
 * just moved on from. Taking the number before the first `await` records press
 * order rather than completion order, which is why the extension needs no
 * ordering logic of its own: this file only ever holds the newest press.
 *
 * Written to a temp file and renamed, because rename is atomic within a
 * filesystem and a reader polling on its own clock will otherwise eventually
 * catch a half-written file. (It would recover — a torn JSON read fails to
 * parse and the next tick retries — but rename costs nothing and removes the
 * case. The temp name carries `mine` so two concurrent calls in this process
 * can never share one; it does not extend across processes — `issued` is
 * module-level, so a second daemon would start from 1 too — but the Stream
 * Deck's exclusive HID handle means a second daemon can never be running to
 * collide with the first.)
 *
 * Every failure is swallowed: the window is already being raised by the time
 * this runs, and a press that reveals no terminal is exactly today's product.
 *
 * `path` and `readProcessTable` exist for `terminal-focus-check`; the daemon
 * passes neither.
 */
export async function requestFocus(session, { path = FOCUS_FILE, readProcessTable = psTable } = {}) {
  if (!session?.pid) return;
  const host = session.host ?? null;
  // A remote session's chain is not walkable here. Its pids belong to another
  // machine, so the local table either doesn't know them or — the case that
  // actually hurts — knows a completely unrelated process wearing the same
  // number. The chain is instead computed during the poll's own fetch, where
  // the remote process table already arrives, and travels on the session: a
  // press must never wait on ssh. No chain means no request at all, because
  // both alternatives (guessing locally, or sending the bare pid) reveal
  // someone else's terminal rather than nothing.
  if (host && !session.ancestors?.length) return;
  const mine = ++issued;
  const tmp = `${path}.${mine}.tmp`;
  try {
    // Only a local session needs the table, and only a local session waits for
    // it — this is inside the `issued` guard either way, so a remote press
    // still loses to a newer one.
    const pids = host ? session.ancestors : ancestorChain(session.pid, await readProcessTable());
    if (mine !== issued) return; // a newer press was issued while ps ran
    await writeFile(
      tmp,
      JSON.stringify({
        pids,
        sessionId: session.session_id ?? null,
        // Named explicitly, never omitted. Pids are unique per machine, so a
        // remote pid is an ordinary number here and a local window would match
        // it by coincidence. The extension compares this against its own host
        // and ignores anything that isn't its own; `null` has to be a value it
        // can compare, not an absence it has to guess about.
        host,
        ts: Date.now(),
      })
    );
    await rename(tmp, path);
  } catch {
    // ps unavailable, ~/.claude unwritable, session gone — all best-effort.
    // A write that succeeded before a later step threw would otherwise leave
    // `tmp` behind forever; unlink it too, ignoring whether it was ever created.
    await unlink(tmp).catch(() => {});
  }
}
