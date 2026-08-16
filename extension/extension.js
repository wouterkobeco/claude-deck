// Reveals the terminal of the Claude Code session whose Stream Deck key was
// pressed. The daemon (claude-streamdeck) writes one request file naming the
// session's ancestor pid chain; every VS Code window runs this and the single
// one that owns a terminal whose shell is in that chain reveals it. The rest
// find no match and do nothing — the request routes itself, so there is no
// port, no token, and no window addressing to get wrong.
const { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const vscode = require("vscode");

const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");
const POLL_MS = 400;
// A request older than this is ignored, so a window that was closed when the
// key was pressed doesn't act on it whenever it next opens.
const REQUEST_MAX_MS = 5000;
// Where this window publishes what it can see, for the daemon to read when it
// decides what a key press means. Named for this extension host's own pid, so
// the daemon can tell a live window from a crashed one exactly
// (`process.kill(pid, 0)`) instead of guessing from a timestamp.
const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");
const STATE_FILE = join(WINDOWS_DIR, `${process.pid}.json`);

let timer = null;
// The last raw file contents seen. Change detection is on the bytes, not on
// the timestamp: `ts > lastTs` would assume a monotonic wall clock, which
// Date.now() is not, so an NTP correction could drop real presses or accept
// stale ones. Comparing contents assumes nothing about clocks.
let lastRaw = null;
// Set for the duration of a match pass. `Terminal.processId` is a Thenable, so
// a pass can outlive its own 400ms tick; without this, a slow pass for an old
// request could resolve *after* a fast pass for a new one and reveal the
// terminal that was pressed first.
let busy = false;
// The terminal this window last revealed, and the session that asked for it.
// Kept as the Terminal *object*: comparing it against window.activeTerminal is
// how we answer "is that session still in front" without any pid involved.
let revealed = null;
// Last JSON written, so an unchanged state costs no write. Six open windows on
// a 400ms tick would otherwise be fifteen writes a second saying nothing
// changed.
let lastState = null;

async function tick() {
  if (busy) return;

  let raw;
  try {
    raw = readFileSync(FOCUS_FILE, "utf8");
  } catch {
    return; // no request has ever been written, or it's unreadable
  }
  if (raw === lastRaw) return;
  // Claimed before the age check, so a stale request is rejected once rather
  // than re-read and re-rejected on every tick for as long as it sits there.
  lastRaw = raw;

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return; // caught mid-write; the next distinct read picks it up
  }
  if (!Array.isArray(request.pids) || Date.now() - request.ts > REQUEST_MAX_MS) return;

  busy = true;
  try {
    for (const terminal of vscode.window.terminals) {
      const pid = await terminal.processId;
      // Belt to `busy`'s braces: if a newer request landed while that resolved,
      // this pass is answering a question nobody is asking any more.
      if (raw !== lastRaw) return;
      if (request.pids.includes(pid)) {
        // Remembered so publishState can answer "is this session's terminal
        // still the one in front" by object identity.
        revealed = { terminal, sessionId: request.sessionId ?? null };
        // Not show(true): the point of the press is to put you in this
        // terminal, so taking keyboard focus is the feature, not a side effect.
        // This also activates the terminal's tab group, which is what brings a
        // joined split forward with the right pane active.
        terminal.show();
        // Publish immediately rather than waiting for the next tick. The
        // daemon reads this to decide whether the *next* press changed
        // anything, and the interval calls publishState() before tick(), so
        // leaving it to the timer would report this reveal a full tick late —
        // up to ~800ms after the press. A second press inside that window
        // would read a stale `activeSessionId`, conclude the press changed
        // something, and re-reveal instead of opening the detail board:
        // the double-press the whole rule is named after would be the one
        // gesture that didn't work. show() has also just taken focus, so this
        // captures the corrected `focused` at the same time.
        publishState();
        return;
      }
    }
    // No match: this session's terminal lives in another window, or its
    // ancestry is broken (tmux, screen, a reparented process). Silent by
    // design — every other window reaches here on every request.
  } finally {
    busy = false;
  }
}

// Publish what this window can see. Synchronous and cheap; the daemon reads it
// from a synchronous key-press handler, so there is nothing to await on either
// end.
//
// Silent on every failure, like everything else here: this runs in every open
// window several times a second, and a window that can't write has nothing
// useful to say about it.
function publishState() {
  try {
    const activeSessionId =
      revealed && vscode.window.activeTerminal === revealed.terminal ? revealed.sessionId : null;
    const state = JSON.stringify({
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      focused: vscode.window.state.focused,
      activeSessionId,
    });
    if (state === lastState) return;
    mkdirSync(WINDOWS_DIR, { recursive: true });
    writeFileSync(STATE_FILE, state);
    // Set only after a successful write, so a failed one is retried next tick
    // rather than remembered as done.
    lastState = state;
  } catch {
    // unwritable ~/.claude, window closing mid-write — nothing to say
  }
}

// Sweep state files whose extension host is gone. A window that crashes or is
// force-quit never runs deactivate(), and the daemon's liveness check only
// asks "does a process with this pid exist" — which stops meaning "that window
// exists" as soon as macOS recycles the number onto something unrelated. The
// daemon would then trust a frozen `focused`/`activeSessionId` from a window
// that died weeks ago.
//
// Done here rather than in the daemon on purpose: the daemon must not delete
// files it did not write, and a window opening or reloading is frequent enough
// that nothing survives long enough for a pid to come back around.
function reapDeadWindows() {
  try {
    for (const name of readdirSync(WINDOWS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const pid = Number(name.slice(0, -".json".length));
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        process.kill(pid, 0); // alive — leave it alone
      } catch {
        try {
          unlinkSync(join(WINDOWS_DIR, name));
        } catch {
          // raced with another window's sweep, or not ours to delete
        }
      }
    }
  } catch {
    // directory doesn't exist yet — nothing to sweep
  }
}

function activate() {
  reapDeadWindows();
  // Two independent concerns on one timer rather than two: publishing is
  // synchronous and must run on every tick, while tick() is async and guards
  // itself with `busy`, so a slow request pass must not also stall publishing.
  //
  // tick() can reject past its own try/catches: `await terminal.processId` on
  // a terminal disposed mid-iteration, or `request.pids` on a parsed `null`
  // (valid JSON, e.g. the literal `null`, but not an object). Either would
  // otherwise surface as an unhandled rejection — a stray Extension Host
  // warning — on every window that doesn't own the terminal, on every
  // request, which is the opposite of the silent no-match this is meant to be.
  timer = setInterval(() => {
    publishState();
    tick().catch(() => {});
  }, POLL_MS);
}

function deactivate() {
  clearInterval(timer);
  // The clean-exit half of cleanup: a window that closes normally takes its
  // own state file with it here. A window that crashes never reaches this
  // function at all — that's what `reapDeadWindows()` in `activate()` is for,
  // sweeping what a crash leaves behind on the next window that opens or
  // reloads. The daemon still must not delete files it did not write, which is
  // why that sweep is the extension's job rather than the daemon's.
  try {
    unlinkSync(STATE_FILE);
  } catch {
    // never written, or already gone
  }
}

module.exports = { activate, deactivate };
