# Editor and terminal integration: focus, window state, the extension

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/vscode-state.mjs` — best-effort reader of VS Code's `state.vscdb` via the
  `sqlite3` CLI, to find a file the target window already has open. Reads an
  undocumented internal format, so *every* failure path returns `null` and the
  caller falls back to a static anchor file. Never make this throw.
  **A remote window is found under a different URI and answers with a different
  thing.** Its `workspace.json` records
  `vscode-remote://ssh-remote%2B<host><path>` rather than `file://<path>` — note
  the percent-encoded `+` — and its editors carry the encoded URI in
  `external`, which is returned verbatim rather than rebuilt, because the raise
  goes through `code --file-uri` and re-encoding an authority by hand is a bug
  waiting to happen. The authority is checked rather than assumed: one folder's
  storage can outlive it being reopened against a different host, and raising
  the wrong host's window is the confusion `folderKeyFor` prevents a layer up.
  **`storageDirFor` only ever matches a window's `folder`**, and a multi-root
  window records a `workspace` instead — so it finds nothing for those, which is
  why the remote branch of `focusWindow` skips the raise rather than guessing
  with `--folder-uri`.
- `src/terminal-focus.mjs` — asks the VS Code window that owns a session's
  terminal to reveal it. The join is process ancestry: `Terminal.processId` is
  the shell's pid and Claude is a descendant of it, so the daemon writes the
  session's whole ancestor chain to `~/.claude/streamdeck-focus.json` and the
  extension picks the terminal whose pid is in it. **The request is
  self-routing** — every window reads the same file and only the one owning a
  match acts, which is why there is no port file, no token and no window
  addressing here, unlike `~/.claude/ide/*.lock`. `issued` is not decoration:
  `requestFocus` is fired without `await` and spawns `ps` before it writes, so
  two quick presses can complete out of order and the *earlier* one would land
  last; the counter is taken before the first `await`, so the file only ever
  holds the newest press and the extension needs no ordering logic of its own.
  Best-effort throughout, like `vscode-state.mjs` — every failure degrades to
  today's behaviour, the window raised and the terminal untouched.
  **Self-routing stops being enough once a host is in play.** A pid is unique
  per machine and nothing else in the request is, so a remote chain full of
  ordinary numbers would match a local terminal by coincidence and reveal a
  stranger's. The request therefore carries `host` and a window acts only on its
  own; `null` is the local value on both sides, compared rather than assumed, so
  a request written before the field existed still reads as local — which is
  what it was. A **remote** session's chain is not walked here at all: it is
  computed during the poll from the `ps` table the fetch already collects, and
  travels on the session. A press is a synchronous key handler and may not wait
  on ssh, and walking the local table for a remote pid is worse than walking
  nothing, because it finds unrelated local processes rather than none.
- `src/cmux-focus.mjs` — the same job as `terminal-focus.mjs` for a session
  running in a cmux pane, and it shares none of the mechanism, because cmux
  needs none of it. **There is no self-routing here and no ancestry walk**: the
  pane addresses itself. cmux starts every pane's shell with `CMUX_PANEL_ID`,
  `CMUX_SOCKET_CAPABILITY`, `CMUX_BUNDLED_CLI_PATH` and `CMUX_BUNDLE_ID` in the
  environment, so the running `claude` process carries the exact pane id, and
  `cmux focus-panel --panel <id>` reveals it. No file, no extension, no reload
  step — the app's own control socket is the channel, and the capability from
  the session's environment is what opens it (without it the socket answers
  *"only processes started inside cmux can connect"*).
  **The environment is read at press time, not on the poll**, for the two
  reasons `terminal-focus.mjs` reads its process table there: a `ps` per session
  every 2s buys nothing, and a capability token is not a thing to hold in polled
  state. `sessions.mjs` answers the cheap question — *is* this a cmux session —
  from the registry's own `tmux` field, which is already read; this module
  answers only the expensive one, *which pane*.
  **The last assignment in the `ps -E` line wins, not the first.** `ps -E`
  prints the command line before the environment, and a command line is not
  inert text: this project's own sessions run with an `--append-system-prompt`
  argument thousands of characters long, so an argument that mentions
  `CMUX_PANEL_ID=` would otherwise be read as the pane to focus. A partial
  environment yields `null` rather than a best guess — a press that spawns a
  subprocess guaranteed to fail is worse than one that logs and does nothing.
  **The pane is selected before the app is raised** (`focus-panel`, then
  `open -b <bundle id>`), so the window that comes forward is already showing
  the right session instead of switching under the cursor. `open -b` by bundle
  id rather than `-a` by name, because the id is the one the pane itself
  reported.
  Local only, by construction: the socket and the capability are on this
  machine. `sessions.mjs` refuses to mark a *remote* session as cmux for that
  reason — its key would otherwise raise a pane on the wrong computer.
- `src/window-state.mjs` — the reverse of `terminal-focus.mjs`: the daemon asks
  for a terminal there and learns what actually happened here.
  **`staleWindows` names the windows still to reload**, rather than leaving
  "4 of 5 windows have the extension" to send you round five of them. It is the
  same comparison kept as a difference instead of collapsed to two integers.
  **The join can only be on folders**: every IDE lock on this machine reports
  the same `pid` — VS Code's *main* process, shared by every window — and a
  lock's filename is its websocket port, so there is no per-window identity on
  that side to match the extension-host pid this file is otherwise keyed by.
  Windows are compared by their folder list, sorted and joined, so a multi-root
  window is one key rather than several (keyed by one folder it would look
  half-covered forever). That leaves exactly one thing it cannot resolve and it
  reports rather than guesses: two windows on the *same* folder are
  indistinguishable here, so the answer is `1 of 2 windows`, not a pointer at
  one of them — the same duplicate-folder ambiguity `focusWindow` has never
  solved, live on this machine with two locks on `kob/kob-backend`. Remote
  windows are compared **per host**: their lock is on the other host, but the
  tree fetch tars that host's `ide/` into the scratch tree, so `staleWindows`
  and `countVsCodeWindows` take `remotes = [{host, dir}]` (`remoteIdeDirs` in
  `index.mjs`) and run the same folder join against the states published for
  that host — `host === null` against local locks, `host === "pi"` against
  pi's — which is what stops a remote path coincidentally covering a local
  one. A stale remote window is named `host:folder`, since kob-backend is open
  on both sides of this machine's ssh. A host not yet fetched falls back to
  counting the windows that published state for it, which is all that was
  ever known about it before its locks were readable. Reads
  `~/.claude/streamdeck-windows/<extension host pid>.json`, one per open VS Code
  window, carrying that window's folders, whether it's focused, and which
  session's terminal is in front. **Synchronous on purpose** — its only caller
  is `deck.on("down")`, a synchronous handler, so an async read would resolve
  after the press was already decided. **The filename is the liveness handle**:
  named for the extension host's own pid, a window that has gone away is
  detected exactly with `isAlive` rather than guessed from a timestamp, which
  is what lets the extension write only on change instead of heartbeating a
  file every 400ms in every open window forever.
- `extension/` — the other half, plain CommonJS with no build step and no
  dependencies, installed by copying it into `~/.vscode/extensions` (a line
  count isn't pinned here for the same reason it isn't for `src/`: it goes
  stale the moment either side grows). Polls the request file every 400ms and
  calls `terminal.show()`, which activates the terminal's tab group — that is
  what brings a joined split forward with the right pane active.
  `extensionKind: ["ui"]` is required, not cosmetic: in a remote window the
  extension host runs remotely, where the request file is another machine's
  and the terminal pids are remote pids.
  **`extension/routing.js` exists so the routing can be checked at all.**
  `extension.js` opens with `require("vscode")`, so nothing in it can be loaded
  outside a running editor — which made this the one piece of the project whose
  bugs surfaced only by reloading a window and watching, and every mistake its
  routing made was found by reading rather than running. `routing.js` requires
  nothing and takes `folders` and `remoteName` as arguments, so
  `extension-check` exercises the real decision path instead of a copy of it.
  Writing that check immediately found a request with no `ts` being accepted
  forever: `now - undefined` is `NaN`, and every comparison against `NaN` is
  false, so the staleness guard read it as fresh. Keep new routing decisions in
  that file rather than inline here, for the same reason. `extension/restore.js`
  is the same split for the restore command, and the part of it worth checking
  is the same part: whose sessions these are. It refuses a session id that
  isn't a UUID — twice, once when filtering the published list and again in
  `resumeCommand` — because that id reaches a shell as `claude --resume <id>`
  and, for a remote window, was chosen by the other machine.
  **Restoring is what was remembered minus what is running**, so an ordinary
  window reload (whose terminals survive) correctly offers nothing, and a second
  run of the command doesn't open a second copy of everything the first one
  restored. The remembering itself is `context.workspaceState`, VS Code's own
  per-workspace storage: scoped to this window by the platform, survives a
  restart, and unlike `streamdeck-windows/` leaves no file for anyone to reap.
  **An empty list is never written over a non-empty one** — quitting VS Code
  kills the terminals before it deactivates extensions, so a snapshot taken then
  would honestly record nothing running and erase the only copy of what to
  restore. `deactivate()` deliberately does *not* take a final snapshot for that
  reason; the last timer tick before the quit is the one that matters. It also does the two things
  `window-state.mjs` reads: publishes this window's folders/focus/active-terminal
  to `~/.claude/streamdeck-windows/<pid>.json` on every tick (and immediately
  after a reveal, so a fast second press doesn't read a stale one), and sweeps
  dead windows' orphaned files at `activate()` (`reapDeadWindows`) — a crashed
  window never runs `deactivate()`, and once its pid is recycled the daemon's
  liveness check would otherwise trust a frozen state file weeks after that
  window died. **Its version tracks the daemon's and `terminal-focus-check` enforces that** —
  a release bumps `package.json` and `extension/package.json` together. The
  number is not bookkeeping: it is the only way to tell a window running the
  current extension from one still running whatever it loaded at startup, which
  no amount of reinstalling changes until the window reloads. VS Code reports it
  (`code --list-extensions --show-versions`, the Extensions view, and
  `Developer: Show Running Extensions`) and the stats board already shows the
  daemon's, so the two agreeing is the entire "does this window need a reload?"
  check, done by eye. Let them drift and that comparison quietly starts lying.

- **The extension rides on `npm install`; the window reload is the step that
  can't.** `postinstall` runs `ext:install`, which copies `extension/` into
  `~/.vscode/extensions` — so a fresh clone or a `npm install` after a pull has
  the current extension without anyone remembering to ask for it. `prestart`
  (`scripts/ext-prompt.mjs`) catches what postinstall misses — an install that
  predates the extension, a copy deleted since, or a copy another worktree
  installed — by comparing `extension/package.json`'s version against the
  installed copy's and offering to fix it, defaulting to yes, at the one moment
  someone is definitely watching. Drift is *named* (`installed is v1.1.19, this
  checkout is v1.1.22`) rather than silently corrected: with one extensions
  slot shared by every worktree, which version is in there is the fact worth
  seeing. This catches a stale copy on disk, never a stale *running* window —
  that still needs the reload below, and the extension publishes no version for
  the daemon to check. It
  never fails the daemon it precedes: no VS Code on the machine, no TTY to ask
  in, or EOF at the prompt all print a line and exit 0. What that
  cannot do is reload the editor: windows already open when it lands keep
  running the *old* code until `Developer: Reload Window`. That is why the
  install ends by saying so. An automatic upgrade nobody
  notices is worse than a manual one they do — the copy is silent, the
  mismatch is silent, and the only symptom is a fixed bug that appears not to
  be fixed.
  **But the question it asks is content, never the version**, and that
  distinction is the whole reason the prompt is worth reading. The two
  package.json versions move together on every release (below), while the
  extension itself changed in 9 commits out of 181 — so a stamp-only bump used
  to name a drift, ask to fix it, and tell you to reload every open window over
  code that was byte-identical. v1.1.29 is exactly that commit. `signature()`
  hashes what VS Code actually loads, with `version` stripped from the manifest
  (it tracks the *daemon*) and `.md` files left out (nothing loads them); equal
  signatures mean the slot is re-stamped **silently** and nobody is asked
  anything. A reload prompt that is usually noise is a reload prompt nobody
  reads, which costs exactly the reloads that matter.
  `ext:install` is that same script under `--yes` — one decision, one copy, and
  the reload line only where it is earned — which is also what keeps
  `postinstall` from printing it on every `npm install`. `--yes` skips the
  is-VS-Code-here gate, because `npm install` has always installed the slot
  unconditionally and failing over a missing `~/.vscode` is the one outcome to
  avoid there. The `mkdir -p` in that script is not decoration either: without it,
  a machine that has never run VS Code fails `npm install` outright over a
  missing directory.
  **A worktree's `npm install` overwrites the installed extension with that
  worktree's copy**, which is worth knowing in a repo where most work happens
  in worktrees — an experimental branch silently becomes the extension every
  window is running. There is only one `~/.vscode/extensions` slot and no
  version in its name, so this is inherent rather than fixable here; if it
  bites, run `npm install` from the main checkout to put it back.
  Terminals survive that reload (`terminal.integrated.enablePersistentSessions`
  defaults on, and ptyHost is a separate process holding the `claude` processes
  up), but prove it on a scratch window before doing it to one with real work in
  it. A window without the extension simply doesn't reveal terminals — never
  make its absence an error, same rule as the status line's context file.
- **Terminal focus makes the duplicate-folder ambiguity worse, deliberately.**
  Two windows open on the same folder (live on this machine already —
  `11854.lock` and `53173.lock` both claim `kob/kob-backend`) route differently
  for the two halves of a press: the extension matches by pid and so reveals the
  terminal in the window that really owns the session, while `focusWindow` opens
  a file and macOS can raise the *other* one. You end up in the wrong window
  with the right window's panel changed behind you. Today's fix would be to aim
  the raise at a specific window, which is not possible from outside the editor
  (see `docs/roadmap-reveal-terminal.md`). Gating the reveal on "is this folder
  unambiguous" was rejected: it would disable the feature for the multi-root
  windows it helps most.
- **Window focus must not disturb the window.** The current route (open a file
  the window already has open) was chosen because `code -r`, `open -a Code
  <folder>` and `vscode://` all either replace a window's content or spawn an
  extra one, and AXRaise needs Accessibility permission. The reasoning is in the
  comment above `focusWindow()` — read it before proposing an alternative.
