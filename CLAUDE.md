# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start              # run the daemon (needs the Stream Deck plugged in)
npm run render-check   # SVG -> RGBA pipeline; writes scripts/render-check-output.png
npm run slots-check    # project grouping / slot assignment
npm run tasks-check    # "task X of Y" numbering, and the SDD ledger fallback
npm run usage-check    # rate-limit parse (add --live to print the raw API response)
npm run stats-check    # stats board formatting
npm run cswap-check    # claude-swap accounts: parsing, graceful absence
npm run title-check    # aiTitle / clearedEmpty / blockedOnDenial / pendingTool / model / effort
npm run subagents-check # which Agent-tool subagents are still running
npm run colors-check   # palette contrast + separation floors
npm run terminal-focus-check # pid-ancestry walk + newest-press-wins guard
npm run vscode-state-check   # which window's storage answers for a folder
npm run extension-check      # whose window a focus request is for
npm run remote-install-check # what remote:install decides before it writes
npm run config-check   # config + board pages: token gate, validation, escaping, focus
npm run statusline-check     # what `npm start` decides your status line needs
npm run statusline:install   # add the context-gauge block here, no question
npm run compact-hook-check   # PreCompact/PostCompact hook decision, settings merge, the script itself
npm run compact-hook:install # add the PreCompact/PostCompact hooks here, no question
npm run history-check  # state log: change-only records, durations, retention, concurrency
npm run tokens-check   # token extraction: incremental reads, grouping, compaction
npm run remote:install -- <host>  # status line + compaction hooks on a remote host
npm run remote-prestart      # what `npm start` checks on every open remote host, on demand
npm run sessions:save  # bundle live sessions' full history for another machine
npm run sessions:restore      # list bundles; -- <file> shows the plan, --write lands it
npm run session-transfer-check # slug/remap/rewrite/plan arithmetic for the above
npm run remote-check   # remote source: host validation, tar/tail framing, matches a local source's output
npm run ext:install    # copy extension/ into ~/.vscode/extensions (reload windows after)
```

The checks are the test suite: plain `node scripts/*-check.mjs` files that
import from `src/`, compare against expected values, and `process.exit(1)` on
mismatch. No framework, no runner — run one by running its script. New
non-trivial logic gets a case appended to the matching check, or a new
`scripts/<thing>-check.mjs` in the same style.

## Architecture

A single polling daemon, a few thousand lines spread across `src/`'s modules
(mapped to design docs below — the count isn't pinned here so this sentence
doesn't go stale every time one is added). Every 2s it rebuilds the whole
board from disk; there is no event stream and no persisted state.

```
~/.claude/{sessions,ide,projects,tasks}   →  sessions.mjs  →  getLiveSessions()
ssh <host> ~/.claude/…              → remote-fs.mjs  ↗              ↓
                                              index.mjs: assignSlots + diff + draw
                                                            ↓              ↓
                                          render.mjs (SVG→RGBA)      Stream Deck
button press → index.mjs → vscode-state.mjs (already-open file) → `open -a "Visual Studio Code"`
                        ↘ terminal-focus.mjs → ~/.claude/streamdeck-focus.json → extension/ → terminal.show()
```

The deep design record lives in `docs/design/`, one doc per working set —
moved there so it loads when that working set is being changed rather than on
every turn. **Read the doc before changing its files; write new design notes
there, not here.** This file only gains a line when a new module or invariant
needs indexing.

| Doc | Covers |
|---|---|
| `docs/design/sessions.md` | `sessions.mjs`, `sdd-ledger.mjs` — reading Claude Code's state; transcript signals (`aiTitle`, `/clear`, `lastPrompt`, `blockedOnDenial`, compacting); nested/subagent synthesis |
| `docs/design/remote.md` | `remote-fs.mjs`, `remote-hosts.mjs` — the ssh fetches, backoff, cached sources, unreachable hosts |
| `docs/design/board.md` | `index.mjs` — slot assignment and its exceptions, the six boards, the detail view, presses, `pulse()`, the self-restart |
| `docs/design/render.md` | `render.mjs` — SVG→RGBA, measured text fitting, the three-tier palette and `colors-check`'s floors |
| `docs/design/usage-stats.md` | `usage.mjs`, `stats.mjs`, `cswap.mjs`, `history.mjs`, `tokens.mjs` — the meters, the state log, the token log |
| `docs/design/vscode.md` | `vscode-state.mjs`, `terminal-focus.mjs`, `window-state.mjs`, `extension/` — focus routing, window state, install/reload |
| `docs/design/web.md` | `config-server.mjs`, `board-page.mjs`, `board-state.mjs`, `html.mjs` — the config/activity/board pages and their trust boundary |
| `docs/design/persistence.md` | `publish-sessions.mjs`, `accents.mjs`, `session-transfer.mjs` — every file the daemon writes, and the read-only invariant in full |
| `docs/design/statusline.md` | `statusline.mjs`, `compact-hook.mjs` — the two manual install steps (context gauge, auto-compaction hooks), local and remote |

### Invariants — the one-line versions

Full arguments, counter-examples and measurements are in the design doc named
on each line. These summaries are reminders, not the rule itself.

- **Ordering is first-seen, never activity** — muscle memory for where a
  button is, and it survives restarts. Exactly four exceptions: the attention
  queue's triage sort, a manual drag on the config page, `promoteActive`,
  `guaranteeRepresentation`. (board.md)
- **A folder's identity is `host:folder` for a remote session, the bare path
  locally** (`folderKeyFor`) — two hosts can hold the same path. (board.md)
- **Nothing in a transcript line is matched as a raw substring** — tool
  results contain other transcripts verbatim; believe only the line's own
  parsed JSON. (sessions.md)
- **Only `clearedEmpty`/`startedEmpty` may blank a key's body** — a session
  nobody has spoken to must read CLEAR, and a working session never may.
  (sessions.md)
- **Redraw is diffed on `btn.drawn`** — a new visual input must join the
  signature or it never appears; build one params object per key, render and
  sign the same object. (board.md)
- **Overlay boards null `btn.renderParams`**, so `pulse()` finds nothing stale
  to redraw when it resumes. (board.md)
- **Read-only**: the daemon itself writes only its own files into `~/.claude/`
  and never edits Claude Code's data on a poll. One sanctioned exception by
  proxy: it runs `cswap list` (hourly at most, cooled down) so cswap refreshes
  its *own* usage cache with its *own* credentials — the daemon still holds
  one credential and writes nothing of another tool's. (usage-stats.md) Two things outside the daemon
  do touch `settings.json`, both additive, both offered — never run — at
  `npm start`: the status line install and the PreCompact/PostCompact
  compaction hooks. `npm start` offers both for every currently open remote
  host too (in parallel, short-timeout, silent on an unreachable one), never
  writing to another machine without that per-host yes. `sessions:restore` is
  the only thing that writes a transcript, and stays a two-step command you
  run, never a poll. (persistence.md, statusline.md)
- **The daemon replaces itself on a version change** (`process.execve` —
  settle window, splash sweep, board resume) and that is the only thing it
  does to itself. (board.md)
- **A guard encoding "X is impossible" is deleted in the commit that makes X
  possible** — three real bugs came from preconditions quietly disappearing
  under guards that still read as correct. (board.md)
- **The poll loop's board branches are unchecked** — prefer anchored edits
  near them; `refreshStats` was once deleted by a text slice and the daemon
  looked healthy for two commits. (board.md)
- **Window focus must not disturb the window**, and two windows on one folder
  stay ambiguous — the rejected alternatives are all recorded; read vscode.md
  before proposing one.
- **A second press means "tell me more"** — matched per session against what
  the extension publishes, never a timeout and no longer the folder.
  (board.md)
- **Nested means spawned by another session** (`entrypoint`, or an Agent-tool
  subagent's transcript), never "in a subdirectory" — a worktree session gets
  a real key. Which key it lands on is `parent`: recorded at synthesis for an
  Agent-tool subagent, found in the pid ancestry for an SDK session, and never
  guessed from the folder. (sessions.md)
- **A key's colour covers its block** (`mostUrgent` over own + nested
  states); every other field is the session's own — with one measured
  exception, a task list found at a *child's* cwd when the session has none of
  its own (an SDD controller's plan lives in the worktree its agent is
  standing in), never at a sibling's, and the caps bar is always
  the project name, never the cwd. (board.md)
- **"compacting" is the `/compact` marker in the transcript, parsed, or the
  PreCompact/PostCompact hook's marker file** — the silence heuristic shipped,
  false-fired on long reasoning, and must not come back; the hook is the only
  non-heuristic way to catch an *auto*-triggered compaction, since it writes
  nothing anywhere until it's already over. (sessions.md, statusline.md)
- **Dishonesty is the bug class refused outright**: a failing host reads
  `offline` rather than vanishing, an empty session reads CLEAR rather than a
  plausible name, a session that reports no `status` reads what its transcript
  says rather than idle, a stopped daemon greys the web board. (remote.md,
  sessions.md, web.md)
- **Hardware: MK.2, 15 keys of 72px, macOS only, exclusive HID.** Keys 13/14
  are reserved (status, usage), leaving 13 session slots; the status key folds
  attention/memory/total and walks attention → working → inactive; queue
  boards page rather than truncate. (board.md)
- **Trust boundaries are not simplified**: the board token gates before
  routing, `esc()` is the five-entity escape, a remote session id is refused
  unless path-safe (`isPathSafeId`), and client JS only ever reports what the
  pointer did — arithmetic lives on the server where checks reach it.
  (web.md, statusline.md)
- **One install step, in the status line**, feeds the context gauge — a
  missing ctx file is never an error, and neither is a window without the
  extension. Without it the gauge falls back to the transcript's own last
  `usage` over a table of *measured* context windows; a model outside that
  table draws no gauge rather than a guessed one. (statusline.md, vscode.md)
- **The extension rides `npm install`; the window reload is manual and
  named** — its version bumps with the daemon's, enforced by
  `terminal-focus-check`. (vscode.md)

## Docs

- `README.md` — user-facing behaviour and the data sources table.
- `docs/superpowers/specs/2026-08-11-*.md` — original design, partly superseded
  (its hook-based status reporting is gone); kept as the record of how the
  design was reached.
- `docs/roadmap.md` — informal backlog, not a design record like the others.
- `docs/roadmap-jetbrains-companion.md` — investigated, not built: a PhpStorm
  companion plugin matching `extension/`'s reach is feasible on public
  IntelliJ Platform API, but its per-window liveness handle needs a different
  design than `process.pid` (JetBrains shares one process across windows).
- `docs/roadmap-reveal-terminal.md` — partly superseded: the extension it
  investigated is now built (`extension/`, `src/terminal-focus.mjs`), so its
  own "investigated, not built" header no longer holds for that part. Still
  worth reading for what it still holds: every non-extension alternative ruled
  out and why (`code` CLI, `vscode://` URIs, the IDE websocket, keystroke
  automation — don't re-investigate any of these), the window-raise-addressing
  problem neither this nor the extension solves (the source for the
  duplicate-folder invariant above), and a second, separately-still-not-built
  investigation into ordering the deck by terminal position.
