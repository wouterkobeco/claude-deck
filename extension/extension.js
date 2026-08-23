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
// Which requests are ours, and what this window's own identity is. Separate
// because this file cannot be loaded outside a running editor — the line above
// sees to that — and that routing is the part worth checking. See
// scripts/extension-check.mjs.
const { sshHost, requestIsOurs } = require("./routing.js");
const { sessionsForWindow, toRestore, resumeCommand } = require("./restore.js");
const { bundleList, restorePlanCommand, saveCommand, transferAvailability } = require("./transfer.js");

const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");
const POLL_MS = 400;
// The daemon's published list of live sessions, local and remote. See
// src/publish-sessions.mjs for why the daemon answers this rather than the
// window reading ~/.claude/sessions itself.
const SESSIONS_FILE = join(homedir(), ".claude", "streamdeck-sessions.json");
// Snapshot cadence. Far slower than POLL_MS on purpose: this is a file read in
// every open window, and its only reader is a command run after a restart —
// being five seconds out of date costs nothing, and five seconds is already
// finer than "the sessions you had open" ever changes.
const SNAPSHOT_MS = 5000;
// Where the snapshot lives between runs: VS Code's own per-workspace storage,
// so it is scoped to this window's folders by the platform, survives a restart,
// and leaves no file to reap when the window goes away for good.
const SNAPSHOT_KEY = "restorableSessions";
// Where this window publishes what it can see, for the daemon to read when it
// decides what a key press means. Named for this extension host's own pid, so
// the daemon can tell a live window from a crashed one exactly
// (`process.kill(pid, 0)`) instead of guessing from a timestamp.
const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");

// Where saved session bundles live. Outside ~/.claude on purpose — the
// transcripts they are made of are swept at 30 days and outliving that sweep
// is the point — and owner-only, since a bundle is a verbatim copy of
// everything a session ever saw. See src/session-transfer.mjs.
const BUNDLE_DIR = join(homedir(), ".claude-deck-sessions");
const STATE_FILE = join(WINDOWS_DIR, `${process.pid}.json`);

let timer = null;
let snapshotTimer = null;
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
  // Freshness, shape, and whose window this request is for — all of it in
  // `routing.js`, which knows nothing about vscode and is therefore the one part
  // of this extension a check can reach. The reasoning for each rule lives with
  // the code there rather than being restated here.
  if (
    !requestIsOurs(request, {
      remoteName: vscode.env.remoteName,
      folders: vscode.workspace.workspaceFolders ?? [],
    })
  ) {
    return;
  }

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
    const folders = vscode.workspace.workspaceFolders ?? [];
    const state = JSON.stringify({
      folders: folders.map((f) => f.uri.fsPath),
      focused: vscode.window.state.focused,
      activeSessionId,
      host: sshHost(folders, vscode.env.remoteName),
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

// This window's sessions, right now, from the daemon's published list. `null`
// when there is nothing to read — no daemon running, or it has never written —
// which is deliberately different from "this window has no sessions": the first
// must not overwrite a good snapshot, and the second is not distinguishable
// from it at the moment VS Code is quitting anyway (see remember()).
function currentSessions() {
  let rows;
  try {
    rows = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return null; // never written, unreadable, or caught mid-rename
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  return sessionsForWindow(
    rows,
    folders.map((f) => f.uri.fsPath),
    sshHost(folders, vscode.env.remoteName)
  );
}

// Remember what is open, for the restore command to offer after the next
// restart.
//
// An empty list is never written over a non-empty one. Quitting VS Code kills
// the terminals before it deactivates extensions, so a snapshot taken in that
// window would record the truth — nothing is running — and erase the only copy
// of what to restore. The cost is that closing every session by hand leaves the
// last non-empty list behind; the restore picker subtracts what is live and
// lets you deselect the rest, so an offer to resume a conversation you finished
// is a keystroke, not a surprise.
function remember(context) {
  const sessions = currentSessions();
  if (!sessions || !sessions.length) return;
  try {
    context.workspaceState.update(SNAPSHOT_KEY, sessions);
  } catch {
    // storage unavailable — the command simply finds nothing
  }
}

// The command: reopen a terminal per session and resume it. One terminal each,
// named and started in the session's own cwd, because that is what was there
// before — `claude --resume <id>` reattaches the conversation, and the cwd is
// what makes the project around it the same one.
async function restoreSessions(context) {
  const live = currentSessions() ?? [];
  const saved = context.workspaceState.get(SNAPSHOT_KEY) ?? [];
  const candidates = toRestore(saved, live);
  if (!candidates.length) {
    vscode.window.showInformationMessage(
      saved.length
        ? "Claude sessions: nothing to restore — every remembered session is already running."
        : "Claude sessions: nothing remembered for this window yet."
    );
    return;
  }

  const items = candidates.map((s) => ({
    label: s.title ?? s.cwd.split("/").filter(Boolean).pop() ?? s.cwd,
    description: s.cwd,
    session: s,
    picked: true,
  }));
  // Multi-select with everything pre-picked: the common case is "all of them",
  // and the picker exists for the one that isn't — a session you closed on
  // purpose and don't want back.
  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Restore Claude sessions",
    placeHolder: "Sessions open in this window before it was closed",
  });
  if (!picks) return; // dismissed

  for (const { session } of picks) {
    const terminal = vscode.window.createTerminal({ name: "claude", cwd: session.cwd });
    terminal.sendText(resumeCommand(session.id));
    terminal.show();
  }
}

/**
 * Where this copy of the extension was installed from, stamped into its own
 * manifest by `ext-prompt.mjs` at install time.
 *
 * The alternative was a setting, which would make everyone configure a path
 * the installer already knew by construction. An unstamped copy — installed by
 * hand, or by a version of the installer that predates this — says so rather
 * than guessing a location and running npm in it.
 */
function deckRoot() {
  // Beside this file, because this file *is* the installed copy — no extension
  // id to hardcode and no activation context to thread through.
  try {
    const root = readFileSync(join(__dirname, ".deck-root"), "utf8").trim();
    if (root) return root;
  } catch {
    // Fall through to the same message: an unstamped copy and an unreadable
    // marker are the same problem from here.
  }
  throw new Error(
    "this copy of the extension doesn't know where claude-streamdeck lives — run `npm install` in that checkout, then reload this window"
  );
}

/** A terminal in the deck's own checkout, running one of its commands. */
function runInDeck(name, command) {
  const terminal = vscode.window.createTerminal({ name, cwd: deckRoot() });
  terminal.sendText(command);
  terminal.show();
}

/**
 * Bundle this window's sessions — full history — for another machine.
 *
 * Scoped to this window's folders rather than the whole machine, because the
 * command is offered per window and named for it. A multi-root window asks
 * which folder: bundling all of them silently would be doing more than the
 * title says, and there is no honest default between two projects.
 */
async function saveForTransfer() {
  const here = transferAvailability(vscode.env.remoteName);
  if (!here.ok) {
    vscode.window.showInformationMessage(here.reason);
    return;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) {
    vscode.window.showInformationMessage("Claude sessions: this window has no folder open, so there is nothing to save.");
    return;
  }
  let folder = folders[0];
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(folders, {
      title: "Save Claude sessions for another machine",
      placeHolder: "Which project?",
    });
    if (!pick) return; // dismissed
    folder = pick;
  }
  runInDeck("claude sessions: save", saveCommand(folder));
}

/**
 * Show what restoring a bundle would do — and stop there.
 *
 * The picker is the part only an editor can offer; the writing is left to the
 * command it prints. Restoring is the one thing in this project that writes
 * Claude Code's own transcripts, and a palette entry that did it on one click
 * would be exactly the quiet write the daemon itself is not allowed to make.
 */
async function restoreFromBundle() {
  const here = transferAvailability(vscode.env.remoteName);
  if (!here.ok) {
    vscode.window.showInformationMessage(here.reason);
    return;
  }
  let names = [];
  try {
    names = bundleList(readdirSync(BUNDLE_DIR));
  } catch {
    // No directory at all is the ordinary "never saved anything here" case.
  }
  if (names.length === 0) {
    vscode.window.showInformationMessage(
      `Claude sessions: no bundles in ${BUNDLE_DIR}. Copy one there from the other machine, or run "Save Claude sessions for another machine" here.`
    );
    return;
  }
  const bundle = await vscode.window.showQuickPick(names, {
    title: "Restore Claude sessions from another machine",
    placeHolder: "Newest first — this shows the plan, and writes nothing",
  });
  if (!bundle) return; // dismissed
  runInDeck("claude sessions: restore", restorePlanCommand(bundle));
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

function activate(context) {
  reapDeadWindows();
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeStreamdeck.restoreSessions", () =>
      restoreSessions(context).catch((err) =>
        vscode.window.showErrorMessage(`Restore Claude sessions failed: ${err.message}`)
      )
    ),
    vscode.commands.registerCommand("claudeStreamdeck.saveSessionsForTransfer", () =>
      saveForTransfer().catch((err) => vscode.window.showErrorMessage(`Save Claude sessions failed: ${err.message}`))
    ),
    vscode.commands.registerCommand("claudeStreamdeck.restoreSessionsFromBundle", () =>
      restoreFromBundle().catch((err) =>
        vscode.window.showErrorMessage(`Restore Claude sessions failed: ${err.message}`)
      )
    )
  );
  // Its own timer rather than a counter on the one below: the snapshot is a
  // file read and a storage write, and there is no reason for it to share a
  // 400ms beat sized for how fast a key press must be answered.
  remember(context);
  snapshotTimer = setInterval(() => remember(context), SNAPSHOT_MS);
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
  clearInterval(snapshotTimer);
  // No final remember() here: by the time this runs the terminals are already
  // gone, so it would record an empty window. The last timer tick before the
  // quit is the snapshot that matters.
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
