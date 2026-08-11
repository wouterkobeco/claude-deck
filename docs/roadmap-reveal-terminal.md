# Roadmap: reveal the session's terminal, not just its window

Status: **investigated, not built** (2026-08-11)

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
