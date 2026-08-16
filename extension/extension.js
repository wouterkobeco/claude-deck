// Reveals the terminal of the Claude Code session whose Stream Deck key was
// pressed. The daemon (claude-streamdeck) writes one request file naming the
// session's ancestor pid chain; every VS Code window runs this and the single
// one that owns a terminal whose shell is in that chain reveals it. The rest
// find no match and do nothing — the request routes itself, so there is no
// port, no token, and no window addressing to get wrong.
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const vscode = require("vscode");

const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");
const POLL_MS = 400;
// A request older than this is ignored, so a window that was closed when the
// key was pressed doesn't act on it whenever it next opens.
const REQUEST_MAX_MS = 5000;

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
        // Not show(true): the point of the press is to put you in this
        // terminal, so taking keyboard focus is the feature, not a side effect.
        // This also activates the terminal's tab group, which is what brings a
        // joined split forward with the right pane active.
        terminal.show();
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

function activate() {
  // tick() can reject past its own try/catches: `await terminal.processId` on
  // a terminal disposed mid-iteration, or `request.pids` on a parsed `null`
  // (valid JSON, e.g. the literal `null`, but not an object). Either would
  // otherwise surface as an unhandled rejection — a stray Extension Host
  // warning — on every window that doesn't own the terminal, on every
  // request, which is the opposite of the silent no-match this is meant to be.
  timer = setInterval(() => tick().catch(() => {}), POLL_MS);
}

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate };
