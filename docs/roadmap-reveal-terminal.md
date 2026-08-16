# Roadmap: reveal the session's terminal, not just its window

Status: **investigated, not built** (2026-08-11)

The "design that does work" section below is superseded by
`docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md`, which
replaces the port-file + HTTP transport with a single self-routing request file.
Everything else here — what was ruled out and why — still stands, and a second
ruled-out investigation (ordering the deck by terminal position) has been added
at the end.

## The gap

Pressing a button raises the right VS Code window. It does not change which
terminal is visible in that window's terminal pane. When several Claude
sessions share a window — split terminals, or joined into one tab group — you
land on the window but possibly on someone else's session.

## Conclusion up front

There is no way to do this without adding a VS Code extension. Every mechanism
that can reveal a specific terminal runs inside the editor: either the
extension API (`Terminal.show()`) or command execution. Neither is reachable
from an outside process.

## What was ruled out, and why

Investigated against VS Code 1.131.0 and Claude Code extension 2.1.227.

### `code` CLI — no

No `--command` / `--run` flag. The full option surface is files, folders,
`--diff`, `--merge`, `--goto`, `--add`/`--remove`, `--profile`,
`--user-data-dir`, extension management and `--add-mcp`. Nothing addresses
terminals.

### `vscode://` URIs — no

VS Code ships no built-in command-runner URI. The Claude extension does
register `window.registerUriHandler`, but with exactly two paths:

- `/install-plugin?plugin=&marketplace=`
- `/open?session=&prompt=` → runs `claude-vscode.primaryEditor.open`

`/open` targets the **native Claude panel**, a different UI from a terminal
session, so it would duplicate the session's presence rather than reveal the
running one. URI delivery also picks a window implicitly, which is the weakest
possible thing to build window addressing on.

### The IDE websocket — no

`~/.claude/ide/<port>.lock` hands out a port and an authToken, so a client can
speak the extension's protocol. Two near-misses in its request dispatcher:

- **`get_terminal_contents`** does call `terminal.show()` — but only as a side
  effect of `selectAll` + `copySelection` + clipboard save/restore, and it is
  gated behind `AT_MENTION_TERMINAL=true`. Using it for focus means clobbering
  the user's selection and round-tripping their clipboard.
- **`exec`** sounds like command execution but `execCommand` is
  `child_process.spawn(cmd, args)` in the extension host — a process spawner,
  not `vscode.commands.executeCommand`. There is no command surface at all.

### Keystroke automation — rejected

`System Events` driving `workbench.action.terminal.focusAtIndexN` works, but
needs Accessibility granted to the whole terminal app. That is the permission
this project deliberately removed; see the note in the README.

## The design that does work

An extension, because **the extension host is per window**. It sees only its
own window's terminals, which removes window-routing guesswork entirely.

### Matching a session to a terminal

`Terminal.processId` is the shell's pid. The session registry gives Claude's
pid. They are related by process ancestry:

```
99684 claude --resume  ←  92021 /bin/zsh -il  ←  2433 ptyHost  ←  1316 Code
```

So: **the daemon sends the session's full ancestor pid chain; the extension
picks the terminal whose `processId` appears in that set.** No title parsing,
no ptyHost detection, no depth assumptions — it survives renamed terminals,
splits, and wrapper processes between `claude` and the shell.

(Title matching was the obvious alternative and is worse: `Terminal.name`
tracks the creation name, not the OSC title Claude sets, and the extension's
own at-mention code has to `name.replace(/ /g, "_")` to work with it.)

### Wiring

1. Extension writes a per-window file — port plus the terminal pids it owns —
   mirroring what Claude's own `~/.claude/ide/*.lock` already does.
2. Daemon POSTs the pid chain to the matching port, then does the existing
   `open -a "Visual Studio Code" <file>` to raise the OS window.
3. Extension calls `terminal.show()`: reveals the panel, makes that terminal
   active in its split.

Roughly 50 lines of extension. A 15-line proof-of-concept can use a URI handler
instead of the port file, at the cost of accepting the window-routing
assumption.

### Risks

- **Installing needs a window reload to take effect in already-open windows.**
  Terminals should survive it (`terminal.integrated.enablePersistentSessions`
  defaults on, and ptyHost is a separate process that keeps the `claude`
  processes alive), but a full-screen TUI reattaching across a reload is worth
  proving on a scratch window before doing it to a window with real work in it.
  New windows need no reload.
- `terminal.show()` opens the terminal panel if hidden and takes keyboard
  focus. Both are wanted here, but they are visible layout changes;
  `show(true)` reveals without stealing focus if that turns out to be
  preferable.

## Side finding: window matching is already ambiguous

Unrelated to terminals, found while reading the locks. Two *different* windows
currently claim the same folder:

- `11854.lock` → `[kob/kob-backend, .claude/plans, kob_data/devbox]` (multi-root)
- `53173.lock` → `[kob/kob-backend]`

`getLiveSessions()` matches with `folders.find((f) => isUnder(s.cwd, f))` over
the flattened folder list, so a kob-backend session resolves to whichever lock
`readdir` happened to return first — i.e. a button can raise the wrong window
today. The per-window pid registry above fixes this as a side effect, since it
identifies the window exactly instead of inferring it from folder containment.

Worth noting the lock's own `pid` field cannot disambiguate: it is `1316` for
every lock, the main Code process, shared across windows.

## Also ruled out: ordering the deck by terminal position

Status: **investigated, not built** (2026-08-15)

The ask was for the deck's keys to run left-to-right in the order the terminals
appear in VS Code's panel — a joined split group read across, or separate tabs in
tab order. The data exists, in two places that share no join key.

### `terminal.integrated.layoutInfo` — the order, but not the identity

In each workspace's `state.vscdb` (the same database `src/vscode-state.mjs`
already opens). For a window with a 50/50 joined split plus two other tabs:

```json
{"tabs": [
  {"isActive": true, "activePersistentProcessId": 98,
   "terminals": [{"relativeSize": 0.4997, "terminal": 98},
                 {"relativeSize": 0.5003, "terminal": 125}]},
  {"isActive": false, "activePersistentProcessId": 100, "terminals": []},
  {"isActive": false, "activePersistentProcessId": 101,
   "terminals": [{"relativeSize": 1, "terminal": 101}]}
]}
```

`tabs[].terminals[]` is exactly the left-to-right pane order wanted. But
`terminal: 98` is a **persistent process id** — ptyHost's internal counter — not
an OS pid, and nothing in the session registry carries one.

### The extension API — the identity, but not the order

`Terminal` exposes `name`, `processId`, `creationOptions`, `exitStatus`, `state`,
`shellIntegration` and its methods (`vscode.d.ts`, `export interface Terminal`).
`processId` is the OS shell pid, which is what joins to a Claude session. There
is no persistent id, no tab membership, and no pane index.

`creationOptions.location` can in principle be a `TerminalSplitLocationOptions`
carrying a `parentTerminal` (`vscode.d.ts:7789`), which is *some* group
information — but it describes how an **extension** asked for a terminal to be
created. Terminals the user made in the UI, and terminals restored from a
persistent session, do not carry it, which is every terminal this feature cares
about.

### Nothing on disk bridges them

Every `%terminal%` key was checked in both the workspace and the global
`state.vscdb`, plus a hunt for a ptyHost state file. `chat.terminalSessions` is
keyed by OS pid, which looked promising, but it is Copilot's and maps pid →
chat session id, with no persistent id in it.

### What's left, and why it wasn't taken

`window.terminals` array order. The d.ts declares only `readonly Terminal[]`
(`vscode.d.ts:11161`) — **no ordering is documented**; empirically it is
append-on-create. That equals left-to-right when you split off the rightmost pane
(the normal Cmd+\ flow), and is wrong after a split from a middle pane or a
dragged pane, until the window reloads.

Trading `CLAUDE.md`'s "Ordering is first-seen, never activity" — and the muscle
memory it exists to protect — for an undocumented approximation that silently
misorders was not worth it.

Reopen if VS Code exposes terminal groups in the API (microsoft/vscode#125916
and relatives), which would make the order exact and documented.

### Side finding: window position is free, and useless here

Ordering the *project blocks* by where their windows sit was considered too.
VS Code persists per-window bounds with no permission required, in
`~/Library/Application Support/Code/User/globalStorage/storage.json` under
`windowsState`, keyed by folder URI. No extension and no Screen Recording
permission needed — but on this machine all four open windows report the
identical rect (`x:0 y:30 2560×1410`), because they are stacked rather than
tiled. There is no left-to-right window arrangement to mirror.

(The same file's `openedWindows` array is an ordered window list, which would
work as a block-order source if that were ever wanted.)
