# Roadmap: a PhpStorm/JetBrains companion, matching `extension/`'s VS Code reach

Status: **investigated, not built** (2026-08-25)

## The gap

PhpStorm sessions already land on the board — `sessions.mjs` matches against
any `~/.claude/ide/*.lock`, not just VS Code's, and `ide` carries JetBrains'
own `ideName` ("PhpStorm"), which `focusWindow` already uses to do
`open -a "PhpStorm"` generically. What's missing is everything `extension/`
adds beyond raising the window: revealing the *right* terminal inside it,
publishing window state for `isRepeatPress`/`staleWindows`, terminal names
(the feature just added for VS Code — see the "branches" rename that started
this), and the restore/backup commands.

## Conclusion up front

Feasible, on public IntelliJ Platform API — not a hack, unlike the VS Code
IDE-websocket dead ends ruled out in `docs/roadmap-reveal-terminal.md`. But it
is a second plugin project in a different language and build system, and one
piece of `extension/`'s design (a per-window pid as the liveness handle)
doesn't transfer as-is.

## What was checked

### Terminal → pid, the whole trick this project depends on — yes

`Terminal.processId` (VS Code) has a direct match:

```java
ShellTerminalWidget.getProcessTtyConnector()   // ProcessTtyConnector, unwraps ProxyTtyConnector too
  .getProcess()                                // java.lang.Process
  .pid()                                       // JDK 9+, no reflection, no internal API
```

Same shell-pid, same ancestor-chain match `terminal-focus.mjs` already does —
nothing about that matching logic would need to change, only which process
writes the request-reader.

### Enumerating a project's terminals — yes

`TerminalToolWindowManager.getInstance(project)`, a per-project service — the
JetBrains equivalent of `vscode.window.terminals`.

### Terminal name — yes, and better than VS Code's

`.getTerminalTitle().getUserDefinedTitle()` — distinguishes a title the user
actually typed from one JetBrains derived, for free. VS Code's `Terminal.name`
doesn't carry that distinction.

### API stability — a real caveat

The classic `ShellTerminalWidget` API above has been stable for years and is
what existing third-party plugins build against. JetBrains' newer "Reworked
Terminal" engine (default since 2025.2) ships its own API surface, live since
2025.3 and still marked experimental — target the classic API, not that one.

## What doesn't transfer: the per-window liveness handle

`extension/extension.js` uses `process.pid` — the extension host's own pid —
as `streamdeck-windows/<pid>.json`'s filename, both identity and liveness
check (`process.kill(pid, 0)`), because VS Code gives each **window** its own
extension host process.

JetBrains doesn't: opening several project windows in one IDE instance runs
them in **one shared JVM process** (one dock icon, one pid) — confirmed by
this machine's own `ide/*.lock` files, all five (across different
folders/windows) sharing `"pid":1414`. The same fact
`docs/roadmap-reveal-terminal.md` already flagged for VS Code's own
multi-root case ("the lock's own pid field cannot disambiguate: it is 1316
for every lock"), true here for a different reason.

So a JetBrains companion needs a file keyed by **project identity**
(`Project.getLocationHash()`, or the folder path the way `ide/*.lock` already
keys itself) instead of pid, plus a heartbeat for liveness instead of
`process.kill`. Not a new problem for this codebase — `history.mjs`'s
`TICK`/`OUTAGE_MS` already solves exactly this shape (tell a quiet daemon
from a stopped one), and the same pattern carries over: stamp a small
per-project file on every publish tick, treat it as dead once its own stamp
is older than a couple of ticks.

## Cost, stated rather than implied

`extension/` is zero-build CommonJS, installed by `cp -r` into
`~/.vscode/extensions`. A JetBrains plugin means Kotlin (or Java) on the
IntelliJ Platform Gradle Plugin, packaged as a zip, installed via "Install
Plugin from Disk" — a second language and a second build pipeline to keep in
step with the daemon's own releases, the way `extension/package.json`'s
version already tracks `package.json`'s.

## Not started

No plugin scaffold exists. Next step, if picked up: a throwaway PhpStorm
plugin that only prints a terminal's pid via `ProcessTtyConnector`, to
confirm the API against a real running PhpStorm before building the rest.
