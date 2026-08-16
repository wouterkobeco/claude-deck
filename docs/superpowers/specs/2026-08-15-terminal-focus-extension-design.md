# Design: reveal a session's terminal, via a VS Code extension

Date: 2026-08-15
Status: **built** (2026-08-15)

There is an amendment at the end of this file — *Verified press escalation*,
2026-08-16, **designed, not built**. Everything before it is shipped and
accurate; the amendment adds a reverse channel and changes what a second key
press means. Read both before changing either.

Supersedes the "design that does work" section of
`docs/roadmap-reveal-terminal.md`. That document's investigation — what was
ruled out and why — still stands and is not repeated here.

## The gap

Pressing a session key raises the right VS Code window. It does not change
which terminal is visible inside it. When several Claude sessions share a
window — split into a joined group, or sitting in separate terminal tabs — you
land on the window but possibly looking at someone else's session.

## What this delivers

One press reveals the pressed session's terminal:

- **A pane inside a joined split** — the tab group comes forward and that pane
  becomes the active one within the split. Both halves, one call.
- **A terminal in its own tab** — the terminal panel opens if hidden and
  switches to that tab.

`Terminal.show()` does both; there is no branching on which case it is.

## What this deliberately does not deliver

- **Ordering the deck's keys by terminal position.** Investigated and dropped;
  findings in `docs/roadmap-reveal-terminal.md`. The `CLAUDE.md` invariant
  "Ordering is first-seen, never activity" is untouched by this work.
- **Fixing the two-windows-one-folder raise ambiguity.** The extension
  identifies the owning window exactly, but the OS-level raise is still
  `open -a "Visual Studio Code" <file>`, which cannot be aimed at a specific
  window. Unchanged — and see "The one case that is worse than today" under
  Errors, because this feature makes that ambiguity's symptom slightly worse.
- **Anything for non-VS Code IDEs.** A JetBrains session keeps today's
  behaviour: the window is raised, the terminal is not touched.

## Architecture

Three pieces. The daemon and the extension share exactly one file and no
other coupling.

```
key press
   ↓
index.mjs focusWindow()
   ├─ open -a "Visual Studio Code" <already-open file>   (raises the OS window, unchanged)
   └─ terminal-focus.mjs requestFocus(session)
          ↓ writes
      ~/.claude/streamdeck-focus.json   { pids: [...], sessionId, ts }
          ↓ polled every 400ms by every window's extension host
      extension/extension.js
          ↓ matches Terminal.processId against pids
      terminal.show()
```

### Matching a session to a terminal

`Terminal.processId` is the shell's pid. The registry gives Claude's pid. They
are related by process ancestry:

```
99684 claude --resume  ←  92021 /bin/zsh -il  ←  2433 ptyHost  ←  1316 Code
```

So the daemon sends the session's **full ancestor pid chain** and the extension
picks the terminal whose `processId` appears in that set. No title parsing, no
ptyHost detection, no depth assumption — it survives renamed terminals, splits,
and any wrapper process between `claude` and the shell.

Title matching was the obvious alternative and is worse: `Terminal.name` tracks
the creation name, not the OSC title Claude sets, and the Claude extension's own
at-mention code has to `name.replace(/ /g, "_")` to work with it.

**Known miss: ancestry can be broken.** `Terminal.processId` is documented as
"the process ID of the shell process" (`vscode.d.ts:7679`), so this works for
`shell → any wrapper → claude`. It does not work when something re-parents the
process out of that tree: `claude` run inside tmux or screen (the server owns it,
not the terminal's shell), a daemonized or otherwise reparented process, or a
session attached to from a terminal that didn't start it. Those sessions get
today's behaviour — window raised, terminal untouched — which is the same
silent no-match as any other failure here. No detection, no warning: the deck
has nowhere to say it.

### Transport: one file, no server

`docs/roadmap-reveal-terminal.md` proposed a per-window port file plus an HTTP
POST, mirroring `~/.claude/ide/*.lock`. That is more machinery than this needs,
and every piece of it is a way to address the wrong window.

Instead the request is **self-routing**: the daemon writes one file naming the
pid chain, every window's extension host reads it, and the single window that
owns a matching terminal acts. The others find no match and do nothing. No
ports, no auth token, no per-window registry, no window addressing to get wrong.

Polled on a `setInterval`, not `fs.watch`: watching a single file that gets
rewritten has inode and does-not-exist-yet edge cases, and a 400ms `stat` of one
small file inside an editor is free. `fs.watch` is the upgrade if it ever
matters.

**What the port approach would genuinely buy, and why it still isn't taken.** An
HTTP POST goes to one live recipient and returns a status, so the daemon would
learn that a request was delivered and matched. This design learns nothing —
a press that matches no terminal is indistinguishable from a press that reached
no extension. That costs nothing today (the deck has nowhere to report it, and
both cases correctly degrade to "window raised, terminal untouched"), and it
would matter the moment there is something to say back. The other thing a
request/response gains — a well-defined ordering between two fast presses — is
handled on the writer side instead; see `requestFocus` below. Until there is a
reply worth reading, a port, an auth token and a per-window registry are three
new ways to address the wrong window in exchange for a status code nobody reads.

### The request file

`~/.claude/streamdeck-focus.json`, written to a sibling temp file and `rename`d
over the target. Rename is atomic within a filesystem, so a reader can never see
a torn write — and because the extension *polls* rather than `fs.watch`es, there
is no watched inode for the rename to break. (Truncate-and-write would mostly
work, since a torn JSON read fails to parse and the next tick retries, but
rename costs nothing and removes the class.)

```json
{ "pids": [99684, 92021, 2433, 1316], "sessionId": "8bb6ffc0-…", "ts": 1755248400000 }
```

- `pids` — the ancestor chain, Claude's own pid first.
- `sessionId` — not used for matching; there so the file is readable when
  debugging which press produced it.
- `ts` — `Date.now()` at write, used **only** as an age gate: the extension
  ignores a request older than `REQUEST_MAX_MS` (5s), so a window that was
  closed when the press happened does not act on it whenever it next opens.

**The extension detects a new request by the raw file contents changing, not by
comparing timestamps.** It keeps the last raw string it saw; identical string
means nothing new. This is deliberate — a `ts > lastTs` comparison assumes a
monotonic wall clock, which `Date.now()` is not, so an NTP correction or a DST
jump could either drop real presses or accept stale ones. Content-change
detection assumes nothing about clocks, and survives a daemon restart (which
would reset any sequence counter and make a `seq > lastSeq` scheme drop every
request until it caught up).

Two presses producing byte-identical content are indistinguishable, and the
second is dropped. That requires the same session pressed twice within the same
millisecond, which a physical key cannot do.

**Ordering between presses is enforced on the writer side, not here.** See
`requestFocus` below: the file only ever holds the newest press, so the
extension needs no ordering logic at all.

## Components

### 1. `src/sessions.mjs` — carry the pid

`getLiveSessions()` already reads `s.pid` from the registry (it calls
`isAlive(s.pid)`) but drops it from the returned object. Add `pid: s.pid` to the
`matched.push({...})` literal.

Subagent pseudo-sessions spread `...s` and so inherit their parent's pid. That
is harmless: subagents hold no board key, so no press ever reaches them.

### 2. `src/terminal-focus.mjs` — new, small

Two exports.

```js
export function ancestorChain(pid, ppidByPid, maxDepth = 20)
```

Pure. Walks up from `pid` collecting each pid until it reaches 1, hits a pid the
map does not know, or reaches `maxDepth`. Returns `[pid, parent, …]`. `maxDepth`
is a cycle guard, not a real limit — the real chain is four deep.

```js
export async function requestFocus(session)
```

Takes a **monotonic sequence number synchronously at call time** from a
module-level counter, then runs `ps -Ao pid,ppid`, parses it into a `Map`, builds
the chain, and writes the file — but only if its own sequence is still the
highest one issued. Otherwise it drops the write.

That guard is the whole fix for the press-ordering race. `requestFocus` is fired
without `await` (see below) and spawns a process before it writes, so two presses
400ms apart can have their `ps` calls complete out of order and the *earlier*
press can land last — leaving the deck having revealed a terminal you already
moved on from. The sequence is captured before the first `await`, so it records
press order rather than completion order. Four lines, and it makes the file
"always the newest press" by construction, which is what lets the extension skip
ordering logic entirely.

Every failure path is swallowed and returns without throwing — same rule as
`src/vscode-state.mjs`: this is best-effort decoration on a press that has
already done its main job. A missing `session.pid` returns immediately.

### 3. `src/index.mjs` — one line in `focusWindow`

`focusWindow(folder, ide)` becomes `focusWindow(session)` and reads
`session.folder` / `session.ide` itself; it already only ever receives
`btn.assigned`. It fires `requestFocus(session)` alongside the existing
`execFile("open", …)`, not awaited — the two are independent and the press must
not block on either.

Only the VS Code path requests terminal focus — but the gate must be written
against the **normalized** app name, not the raw field. `session.ide` is
`ideByFolder.get(...) ?? null` (`sessions.mjs:473`), and a lock file without an
`ideName` yields `null` for a perfectly ordinary VS Code window. `focusWindow`
already handles this with `const app = ide ?? "Visual Studio Code"`
(`index.mjs:158`); the request must be gated on `app`, reusing that same local.
Gating on `session.ide === "Visual Studio Code"` would silently disable the
feature for every session whose lock omits the field.

Two call sites, both in the `down` handler (`index.mjs:849` and `index.mjs:879`):
the attention-board exit press, and the normal session press — the latter
covering both the first and the repeat press, which already share one call.

### 4. `extension/` — the extension

Monorepo, not a second repository: `extension/` with its own `package.json`.
The root `package.json` is untouched apart from one script; the two halves
share no code, so npm workspaces would add hoisting surprises to a `sharp` +
`node-hid` dependency tree for no benefit.

**Deviation from the original plan below: plain CommonJS, no build step.**
This was designed as TypeScript — `src/extension.ts`, a `tsconfig.json`, a
`.vscodeignore`, packaged with `vsce` into a `.vsix` and installed with `code
--install-extension`. What shipped is `extension/extension.js`, required
directly by VS Code's extension host (which runs plain Node), with no compile
step, no `.vsix`, and no dependency of its own. `npm run ext:install` copies
the folder straight into `~/.vscode/extensions/claude-streamdeck-terminal-focus`
and a window reload picks it up. Deliberate, not a shortcut that slipped
through: ~90 lines of `require("vscode")` and two file-system calls need
nothing TypeScript's toolchain buys — no npm install, no `tsc`, no `vsce`, no
packaging step, no `.vsix` to keep in sync with source — and it removes the
only build artifact this repo would otherwise have besides a rendered PNG. If
this file ever needs types, dependencies, or a build step, revisit the
decision then; it does not need it today.

```
extension/
  package.json    name, activationEvents, extensionKind, engines
  extension.js    ~90 lines
  README.md
```

`package.json` essentials:

- `"activationEvents": ["onStartupFinished"]` — it must be running before any
  press, and it has no command or view to activate it lazily.
- `"extensionKind": ["ui"]` — it reads a file on the machine the daemon runs on.
  In a remote window the extension host runs remotely by default, where
  `~/.claude/streamdeck-focus.json` is a different machine's file and terminal
  pids are remote pids that no local `ps` will match. `ui` pins it local.
- `"contributes": {}` — no commands, no settings, no views. Nothing to
  configure.

`extension.js`:

```
activate():
  interval = setInterval(() => tick().catch(() => {}), 400)
                                 // tick can reject past its own guards — a
                                 // terminal disposed mid-await, a parsed
                                 // `null` whose .pids throws — and the
                                 // no-match path has to stay silent, so the
                                 // interval callback swallows rather than the
                                 // caller printing an Extension Host warning
                                 // on every window, every 400ms

tick():
  if busy: return                        // reentrancy guard, see below
  raw = read the file                    → return on any failure
  if raw === lastRaw: return
  lastRaw = raw                          // set before the age gate, so a stale
                                         // request is rejected once, not every tick
  req = parse(raw)                       → return on any failure
  if now - req.ts > REQUEST_MAX_MS: return
  busy = true
  try:
    for each vscode.window.terminals:
      pid = await t.processId
      if lastRaw !== raw: return         // a newer request arrived mid-await
      if req.pids.includes(pid): t.show(); return
  finally:
    busy = false

deactivate():
  clearInterval(interval)
```

Two guards, for the same underlying hazard: `processId` is a
`Thenable<number | undefined>` (`vscode.d.ts:7679`), so a tick can outlive its
own 400ms interval. Without them, tick A reads request A and awaits, tick B reads
request B and shows B, then tick A resumes and shows A — the deck reveals the
terminal you pressed *first*. `busy` stops ticks overlapping at all; the
`lastRaw !== raw` re-check before `show()` is the belt to that braces, and is
what actually guarantees the newest request wins if the guard is ever bypassed.

`show()` rather than `show(true)`: the point of the press is to put you in that
terminal, so taking keyboard focus is wanted, not a side effect to avoid.

No match is silent. A session running outside a VS Code terminal, or in a window
without the extension installed, simply gets today's behaviour.

## Errors

Almost every failure degrades to "the window is raised, the terminal is not
revealed" — exactly the current product.

| Failure | Result |
|---|---|
| `ps` fails or is slow | no file written, press behaves as today |
| A newer press was issued first | write dropped by the sequence guard, newest press wins |
| File missing / mid-write / corrupt | extension's `tick` returns, next tick retries |
| No terminal matches | nothing shown, silently |
| Ancestry broken (tmux, screen, reparented) | no match, silently |
| Extension not installed, or window not reloaded since install | nothing shown, silently |
| Session's terminal is in a remote window | pids don't match, silently |

### The one case that is worse than today

**Two windows with the same folder open.** The extension routes by pid, so it
reveals the terminal in the window that genuinely owns the session. The OS raise
does not: `focusWindow` opens a file, and `openFileIn` picks a storage directory
by folder and newest `state.vscdb` (`vscode-state.mjs:37-45`), so macOS can raise
the *other* window. The roadmap doc found exactly this already live —
`11854.lock` and `53173.lock` both claim `kob/kob-backend`.

Result: you are looking at the wrong window, and the right window's terminal
panel has silently changed underneath you. Today's version leaves that window
alone. This is a real regression in that case, not a neutral no-op, and the spec
does not fix it — the raise cannot be aimed at a specific window from outside the
editor (see `docs/roadmap-reveal-terminal.md`).

Accepted as-is rather than papered over: the failure is confined to duplicate
folder windows, it changes a panel rather than any file or process, and gating
the terminal reveal on "is this folder unambiguous" would disable the feature for
the multi-root windows it is most useful in.

## Testing

`scripts/terminal-focus-check.mjs`, in the established style — plain node,
imports from `src/`, `process.exit(1)` on mismatch, added to `package.json` as
`terminal-focus-check` and to `CLAUDE.md`'s command list.

`ancestorChain` is the only non-trivial logic and it is pure, so the check
feeds it a fixture ppid map:

- the four-deep real chain resolves to all four pids
- a pid absent from the map returns just itself
- a cycle (`a → b → a`) terminates at `maxDepth` rather than hanging
- pid 1 terminates the walk

The sequence guard in `requestFocus` is the other piece of real logic, and it is
checkable without a deck because the ordering hazard is on the writer side:
call `requestFocus` twice back-to-back without awaiting either, resolve them out
of order, and assert the file holds the second call's pids. Point `CLAUDE_DIR` at
a temp directory for it — that is the one thing this check needs the module to
allow, and it is the reason the path should be resolved at call time rather than
frozen in a module-level `const`.

The extension is not unit-tested: ~90 lines of VS Code API that only a running
editor can exercise. It is covered by the manual acceptance below.

## Manual acceptance

1. Install: `npm run ext:install` (copies `extension/` straight into
   `~/.vscode/extensions/claude-streamdeck-terminal-focus` — no packaging, no
   `.vsix`, see the deviation noted under "extension/" above).
2. **Reload a scratch window first.** Already-open windows need
   `Developer: Reload Window` for the extension to activate in them.
   `terminal.integrated.enablePersistentSessions` defaults on and ptyHost is a
   separate process that keeps the `claude` processes alive, so terminals should
   survive — but a full-screen TUI reattaching across a reload is worth proving
   on a window with nothing at stake before doing it to one with real work in it.
3. In one window, two Claude sessions joined into one split group. Press each
   key: the group comes forward and the pressed session's pane is active.
4. Same window, two Claude sessions in separate terminal tabs. Press each key:
   the correct tab is selected.
5. Terminal panel hidden. Press a key: the panel opens on the right terminal.
6. Two windows, one Claude session each. Press each key: only the right window's
   terminal changes; the other window is untouched.
7. Press a key for a JetBrains session: window raised, nothing else changes.
8. **Press two different session keys in quick succession.** The terminal that
   ends up revealed is the second one, every time — this is the press-ordering
   race, and it is the failure most likely to survive into shipping because it
   only shows under fast input.
9. A session whose lock file has no `ideName` (so `session.ide` is `null`): the
   terminal is still revealed. This is finding #1 from the Codex review and it
   would otherwise fail silently for most sessions.
10. Kill the daemon mid-press: no orphaned state, the file is inert.

## Security

`~/.claude/streamdeck-focus.json` is a user-owned file in a user-owned
directory. Anything that can write it can cause a terminal to be revealed in the
user's own editor — no data leaves the machine, nothing is executed, and
anything able to write there can already read the transcripts and the OAuth
token this project's `usage.mjs` uses. Not a new boundary.

## Install cost

This is the project's second install step, after the status-line block, and the
first that is not a copy-paste. `CLAUDE.md`'s "Read-only, near-zero-install"
invariant needs amending to say so: the daemon itself stays read-only apart from
this one request file, but the extension is a real install with a real reload.

Accepted deliberately — the roadmap doc's conclusion was that there is no way to
reveal a specific terminal from outside the editor, and this is the smallest
inside-the-editor thing that works.

## Ordering

The original ask also included ordering the deck's keys left-to-right to match
the terminal panel. It was investigated and dropped — the two data sources share
no join key. It is not part of this spec and needs none of this spec's
machinery; the findings live with the rest of the ruled-out work, in
`docs/roadmap-reveal-terminal.md`.

---

# Amendment: verified press escalation

Date: 2026-08-16
Status: **designed, not built**

Adds a reverse channel — the extension publishes what it can see, the daemon
reads it when deciding what a key press means. Everything above still stands;
this section only adds to it.

## Why the original rule expired

`CLAUDE.md` documents the repeat-press rule and justifies matching on the
**folder** rather than the key:

> The match is on the folder, not the key: a project's sessions sit in one
> contiguous block, so moving along that block is the same gesture as pressing
> one key twice — either way you're already looking at that project.

That reasoning was sound when a press could only raise a **window**. Every key
in a project's block did the identical thing, so a second press had nothing new
to give you and escalating to the detail board was the only useful next step.

**Terminal focus falsified the premise.** Pressing key A and then key B now
produce visibly different results — two different terminals. B is not a repeat
of A; it is a new first press. The observed symptom: with two Claude sessions in
one window, pressing the second session's key opens the detail board instead of
switching to that session's terminal, so the deck cannot do the one thing the
extension was built for.

The rule this replaces it with: **a press escalates only when it changed
nothing.** If the press had to switch terminals, it was a first press.

## Why this needs a reverse channel

"Changed nothing" is not knowable from the daemon side. It needs two facts that
live only inside the editor: whether that window is focused, and which terminal
is currently in front. `docs/roadmap-reveal-terminal.md` and the transport
section above both closed the door on a reply channel, correctly, with the
caveat that it *"would matter the moment there is something to say back."* This
is that moment.

The daemon could instead **infer** it — "you pressed this same session last
time, so its terminal must still be showing." One line, no channel. Rejected
because it is wrong in exactly the cases a user notices: after alt-tabbing away,
and after clicking a different terminal by hand. Both leave the deck opening a
detail board when it should have brought you back.

## The latency problem, and why there isn't one

The press handler decides "first or second" synchronously, in `deck.on("down")`.
The extension cannot answer a question in that window — its poll is 400ms and a
press must feel instant.

So the extension does not answer requests. **It publishes state continuously**,
and the daemon reads the latest at press time. Request/response would have
forced the press to wait; published state costs the press nothing.

## What the extension publishes

`~/.claude/streamdeck-windows/<extension-host pid>.json`, one per window:

```json
{
  "folders": ["/Users/wouterd/projects/claude-streamdeck"],
  "focused": true,
  "activeSessionId": "9a3577e2-d87a-42be-8037-fec01df440cf"
}
```

- `folders` — `vscode.workspace.workspaceFolders` mapped to filesystem paths,
  mirroring what `~/.claude/ide/*.lock` already publishes. This is what lets the
  daemon tell *which* window a session belongs to.
- `focused` — `vscode.window.state.focused` (`vscode.d.ts:11040`).
- `activeSessionId` — the session whose terminal is currently in front, or
  `null`.

**`activeSessionId` is derived by object identity, not by pid.** The extension
already remembers the `Terminal` it last revealed and the `sessionId` from the
request that revealed it. Each tick it compares `vscode.window.activeTerminal`
(`vscode.d.ts:11167`) against that remembered object: still the same one →
publish that session id; anything else → publish `null`. No pid chain crosses
this channel, and the daemon needs no `ps` call at press time — which is what
keeps the press synchronous.

### Keyed by the extension host's pid

The filename is the extension host's own `process.pid`. That gives the daemon
exact liveness: `process.kill(pid, 0)`, the same trick `sessions.mjs`'s
`isAlive` already uses on session pids. No timestamps, no staleness window, no
guessing whether a window is gone.

**Written only on change**, never on a heartbeat. Six open windows writing every
400ms is fifteen pointless writes a second for state that changes when you
switch terminals. The extension keeps the last JSON string it wrote and skips
the write when nothing differs — the same content-comparison trick the request
reader already uses.

The extension unlinks its own file in `deactivate()`. A window that crashes
leaves an ~80-byte orphan which the liveness check ignores forever. Accepted
rather than building a reaper for it: the file is inert, bounded at one per
window instance, and a daemon that deletes files it did not write is a worse
trade than a few dead bytes.

## The new rule

At press time, in order:

1. Find a **live** window whose `folders` contain the pressed session's folder,
   using `matchFolder` from `sessions.mjs` — the same function that already
   resolves a session's cwd to an open window, with exact-match-beats-ancestor
   and longest-ancestor-wins already settled. No second implementation.
2. **No such window** → that window is not running the extension. Fall back to
   today's folder rule, unchanged.
3. **Found** → escalate to detail only if the previous press was the **same
   session** *and* that window reports `focused: true` with `activeSessionId`
   equal to this session.

| Sequence | Result |
|---|---|
| press A, press A | detail — window focused, A's terminal already in front |
| press A, press B | switch to B's terminal, a first press |
| press A, alt-tab away, press A | raise the window, **not** detail |
| press A, click terminal B by hand, press A | switch back to A, a first press |
| window without the extension | today's folder rule |

Both conditions are required. The previous-press chain stays because "second
click" is the gesture being described; the window state is what makes it
truthful.

## Graceful degradation is per window, not per machine

Checking whether the extension is *installed* — testing for
`~/.vscode/extensions/claude-streamdeck-terminal-focus` — would be the wrong
check, and there is direct evidence why: on 2026-08-16 it was installed and
**zero** open windows were running it, because every window predated the install
and none had been reloaded. An install check would have answered "yes" and been
useless.

A live window-state file *is* the detection, and a better one: it proves that
**this specific window** is running the extension, which is the fact that
actually decides how its keys should behave.

The consequence, during the reload migration: **two windows behave differently
and nothing on the deck says which is which.** A sibling key press switches
terminals in a reloaded window and opens detail in a stale one. That is inherent
to degrading per window rather than a flaw in it, and it resolves itself once
every window has been reloaded. The alternative — one global switch — would make
the deck's behaviour depend on which window you last reloaded, which is worse.

## Components

### `extension/extension.js` — publish state

A second interval concern alongside the existing request poll, sharing its
timer. Per tick: read `window.state.focused` and compare
`window.activeTerminal` against the remembered revealed terminal; build the
JSON; write only if it differs from the last write. Record the revealed
`Terminal` object and its `sessionId` at the point `terminal.show()` is called.
`deactivate()` clears the timer and unlinks the file.

Same silence rule as everything else here: every failure path returns without
logging.

### `src/window-state.mjs` — new, small

Reads `~/.claude/streamdeck-windows/`, drops entries whose pid is not alive,
returns the live ones. Pure apart from the directory read, best-effort
throughout — an unreadable or half-written file is skipped, never thrown.

Its own module rather than more lines in `terminal-focus.mjs`: that file is the
*writer* half of a one-way channel, and this is the reader half of the other
one. `vscode-state.mjs` is the precedent — one best-effort external read per
file.

### `src/index.mjs` — the rule

`isRepeatPress(previous, press, windows)` gains the window list. The press
handler reads window state once per press and passes it in. The function stays
pure and exported, for the same reason it already is: none of this is visible
without a deck.

## Errors

Every failure degrades to today's behaviour — the folder rule — because that is
what step 2 already does for a window with no extension. There is no path here
that can make a press throw: the reader is try/catch-per-file and the press
handler treats an empty list as "no extension anywhere."

| Failure | Result |
|---|---|
| Directory missing (extension never ran) | empty list → folder rule |
| A file mid-write or corrupt | that window skipped → folder rule for it |
| Window crashed, file orphaned | pid not alive → skipped |
| Extension loaded but has revealed nothing yet | `activeSessionId: null` → never escalates until it has |

## Testing

`scripts/slots-check.mjs` already covers `isRepeatPress` and is where this
belongs — it is the check that pins press semantics.

The assertion at `slots-check.mjs:345` — *"a sibling session of the same project
counts as the second press"* — **inverts**, and its replacement should say why,
since a future reader will otherwise assume it was a mistake.

Cases: sibling is no longer a repeat; same session with `focused: true` and
matching `activeSessionId` escalates; same session with `focused: false` does
not; same session whose `activeSessionId` is null or another session does not;
a session whose folder matches no live window falls back to the folder rule
(including the old sibling behaviour); a dead pid is treated as no window.

The extension's publishing half is not unit-tested, for the same reason the
reader half wasn't: it is VS Code API that only a running editor exercises.

## Manual acceptance

The two windows in `claude-streamdeck`, both with a Claude session:

1. Press session A's key twice — detail opens on the second.
2. Press A, then B — B's terminal comes forward; no detail board.
3. Press B again — detail opens for B.
4. Press A, alt-tab to another app, press A — the window is raised, no detail.
5. Press A, click B's terminal by hand, press A — A's terminal returns, no detail.
6. In a window that has **not** been reloaded since install, press two sibling
   keys — today's behaviour, detail on the second press.
7. Quit VS Code entirely and reopen — no stale window-state file changes
   behaviour.

## Install cost

None beyond what already exists. The new file appears the first time a reloaded
window runs the extension, and its absence is a supported state rather than an
error.

## Invariant amended, again

`CLAUDE.md`'s **"Read-only, two install steps"** currently claims the daemon
writes exactly one file. Still true — the daemon does not write here at all;
this directory is written by the extension and only *read* by the daemon. The
invariant needs a sentence saying so, because "the daemon writes one file" is
now sitting next to a second file the daemon knows about, and the next reader
will assume it writes that one too.
