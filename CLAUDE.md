# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start              # run the daemon (needs the Stream Deck plugged in)
npm run render-check   # SVG -> RGBA pipeline; writes scripts/render-check-output.png
npm run slots-check    # project grouping / slot assignment
npm run tasks-check    # "task X of Y" numbering
npm run usage-check    # rate-limit parse (add --live to print the raw API response)
npm run stats-check    # stats board formatting
npm run title-check    # aiTitle / clearedEmpty / blockedOnDenial / model / effort
```

The checks are the test suite: plain `node scripts/*-check.mjs` files that
import from `src/`, compare against expected values, and `process.exit(1)` on
mismatch. No framework, no runner — run one by running its script. New
non-trivial logic gets a case appended to the matching check, or a new
`scripts/<thing>-check.mjs` in the same style.

## Architecture

A single polling daemon, ~1800 lines across six modules. Every 2s it rebuilds
the whole board from disk; there is no event stream and no persisted state.

```
~/.claude/{sessions,ide,projects,tasks}   →  sessions.mjs  →  getLiveSessions()
                                                                   ↓
                                              index.mjs: assignSlots + diff + draw
                                                            ↓              ↓
                                          render.mjs (SVG→RGBA)      Stream Deck
button press → index.mjs → vscode-state.mjs (already-open file) → `open -a "Visual Studio Code"`
```

- `src/sessions.mjs` — the only reader of Claude Code's state. Joins the
  session registry against open VS Code workspace folders (a session with no
  local window is dropped), then enriches with `aiTitle` (tail-scanned from the
  transcript jsonl), task progress, and context usage. Every file read is wrapped in try/catch
  that skips rather than throws: these files are written by another process and
  a poll can land mid-write. `readTranscriptSignals` reads `aiTitle` and two
  more things from that same tail scan — see the two invariants below.
- `src/index.mjs` — daemon loop, slot assignment, focus. Exports `assignSlots`,
  `accentFor`, `attentionQueue` and `detailLayout` for the checks; the
  `import.meta.url === argv[1]` guard at the bottom is what keeps importing it
  from starting a daemon. Also owns **which board is showing**: one `view`
  value local to `run()`, never a flag per board, so "stats and detail are both
  somehow on" isn't representable. Its four kinds — `sessions`, `stats`,
  `attention`, `detail` — each have one branch in the poll loop and one
  `refresh*` function, and the same 13 session keys are redrawn by whichever is
  current. The `drawn`-signature diffing does the switching for free: signatures
  never match across boards, so a mode change redraws everything once and needs
  no explicit invalidation. The stats board's top-left pair ("Session reset" /
  "Week reset") isn't from stats.mjs — it's `usage.mjs`'s
  `sessionResetsAt`/`weekResetsAt` reduced to hours/days, prepended in
  `index.mjs` because they change by the hour/day while the all-time totals
  barely move.
- **One session across the whole deck: the detail view.** A second press on a
  session key (see the repeat-press rule below) opens `refreshDetail`, which
  takes over **all 15 keys** — usage and attention included, unlike every other
  board, which draws only the 13 session keys. `detailLayout` lays out a
  two-key title, STATE/CONTEXT/MODEL stat tiles, then that session's task list
  coloured by status, with its subagents (the sdk sessions it spawned)
  pinned to the tail — a twenty-task plan must not push the only way
  to see those off the board. Because it covers the whole deck it owes an
  unambiguous exit: a back key at `DETAIL_BACK_INDEX` (10, the bottom-left
  button — keys are row-major across 5 columns). It is spliced in at that fixed
  index after the content is laid out, so it lands on the same physical key
  however the tiles above it happen to fill. That back key is also the *only*
  way out: every other key there describes something, and pressing a task or a
  subagent shouldn't throw the board away. Because it owns all 15 keys, the
  poll loop must not also call `drawAttention` or `drawUsage` on that tick —
  both paint keys the detail board is holding, and the two writes fight for
  the key on every poll, which reads as a flashing key. `detailLayout` is pure and
  exported precisely because that slot arithmetic is where an off-by-one
  silently hides a task; `slots-check` covers it. The task list is read here,
  per poll, never in `getLiveSessions()` — the board's own 2s poll costs what it
  always did. The layout is captured once (`view.tiles`) and then held by
  `holdTiles` while content keeps refreshing: `taskWindow` re-centres on the
  in-progress task, so recomputing it every poll would slide the board under
  your finger each time a task completed. `holdTiles` is exported and checked
  for the same reason `detailLayout` is — it also has to stop a worktree
  session drawing on two keys at once, which `detailLayout` re-pinning its tail
  every poll otherwise causes and which nothing but a deck would show you.
- **`/clear` reuses the transcript file.** It's written as an ordinary line
  (`<command-name>/clear</command-name>`) into the same `.jsonl`, not a new
  file, so a naive backward scan for `aiTitle` would keep surfacing the
  pre-clear summary. `readTranscriptSignals` stops at the most recent `/clear`
  instead; if nothing's been said since, it reports `clearedEmpty: true` and
  `index.mjs` shows a blank body rather than falling back to the session name
  or cwd — those would look like a real answer when the honest one is
  "nothing yet".
- **"idle" can mean "asked you for permission and is waiting."** Claude
  Code's session `status` reports a turn that ends right after an auto-mode
  permission denial exactly the same as any other completed turn: `idle`.
  `readTranscriptSignals`'s `blockedOnDenial` catches the one case that
  matters — the newest `type:"user"` line in the tail is a denied tool result
  with no human reply after it — and `getLiveSessions()` promotes that session
  to `requires_action`. It's a narrow signal, not certainty (an assistant that
  quietly recovers and keeps working would also match, briefly); good enough
  for a key that needs to catch your eye, not a guarantee.
- **Requires-action keys pulse.** `pulse()` in `index.mjs` is a second loop
  alongside the main poll, ticking every `PULSE_MS` (400ms) — the 2s poll is
  far too slow to read as animation. It redraws only the keys with something
  flashing on them — `requires_action` keys, keys carrying nested markers, and
  the attention key when its count is nonzero — reusing `btn.renderParams`
  (cached every poll in `refresh()`/`drawAttention()`, not just on change)
  rather than re-deriving from a fresh session read. It never touches
  `btn.drawn`, so the next `refresh()` still recognises a steady frame as
  unchanged and leaves the button alone.
- `src/render.mjs` — builds an SVG string per key and rasterizes with sharp.
  Pure: takes geometry + data, returns a buffer. Text fitting is hand-rolled
  character-width estimation, so layout changes need `render-check` looked at,
  not just run.
- `src/usage.mjs` — the two rate-limit windows for the bottom-right key. These
  numbers exist only server-side, so it reads the CLI's own OAuth token from the
  login keychain and asks the API, cached 60s. The only outbound network call in
  the project, and the only credential it touches.
- `src/stats.mjs` — all-time stats board (favorite model, total tokens,
  streaks, ...), read from `~/.claude/stats-cache.json`, cached 30s. Values are
  validated against a real screenshot of the source tool's own output (see the
  pinned `formatDuration` case in `stats-check`); don't change the formatting
  helpers without re-checking against a real cache file.
- `src/vscode-state.mjs` — best-effort reader of VS Code's `state.vscdb` via the
  `sqlite3` CLI, to find a file the target window already has open. Reads an
  undocumented internal format, so *every* failure path returns `null` and the
  caller falls back to a static anchor file. Never make this throw.

### Invariants worth knowing before changing things

- **Ordering is first-seen, never activity.** `folderOrder` and `sessionOrder`
  in `index.mjs` are append-only maps for the daemon's lifetime. Folders are
  deliberately kept after their last session ends so a returning project
  reclaims its slot and accent colour. Anything that re-sorts a settled board
  breaks the point of the tool: muscle memory for where a button is.
  **The attention queue is the one exception**, deliberately: `attentionQueue`
  ranks blocked ahead of waiting and longest-stuck first inside each group.
  It's transient triage — you read it, act, and leave — so there's no muscle
  memory for it to break, and it re-sorts while it's up so a session that gets
  unblocked leaves the queue you're looking at. When the last one clears, the
  poll loop leaves too (`view` flips back to `sessions` the moment
  `refreshAttention`'s returned count hits 0) — an empty queue must not look
  like the daemon died. The detail board is *not* an exception: its shape is
  fixed for the visit, but a session that ends mid-visit isn't held stale
  either — `refreshDetail` blanks every tile and returns `null`, and the poll
  loop leaves the board the same way.
- **Redraw is diffed** on the `btn.drawn` signature string in `refresh()` and in
  every other `refresh*`. Any new visual input must be added to that string or
  it will not appear until something else changes — a real bug twice already
  on the queue tiles (`accent` and `context` drawn but not signed, then
  `progress` drawn nowhere at all). All four `refresh*` functions now build
  one object per key and both render and sign it (`` `queue
  ${JSON.stringify(params)}` ``, etc.) — a field can't be forgotten from one
  without the other, because there's only the one object. `refreshStats` gets
  this for free: its per-tile `stat` object (`{ label, value }`) already *is*
  what's spread into `renderStat`, so signing it directly needed no separate
  `params` variable. Copy this shape for any new board.
- **Overlay boards must null `btn.renderParams`.** `pulse()` runs on its own
  400ms tick and is frozen while a non-`sessions` board is up, but it resumes
  the instant one is dismissed and redraws from whatever `renderParams` still
  holds — the pre-overlay data, however old. `refreshAttention` and
  `refreshDetail` both null it, so pulse finds nothing to redraw until the next
  `refresh()` repopulates it, at most 2s later. The attention key has a
  related problem: `pulse()` only ever touches it while the *sessions* board
  is showing (the whole body is gated on `isOverlayView()`), but a view
  change can land between two of its ticks — the view flips away right after
  pulse mid-tick wrote a bright frame. Nothing then has reason to repaint it:
  `drawAttention`'s own signature only changes when the queue itself changes,
  not because pulse wrote something. `run()`'s `setView()` helper nulls
  `attentionButton.drawn` on every transition so the next `drawAttention` call
  repaints it for real regardless of what pulse left behind.
- **Read-only, near-zero-install.** No hooks, no `settings.json` writes, no
  config file. The daemon itself only reads — from `~/.claude/`, VS Code's
  storage, and the usage endpoint. An earlier hook-based version was deleted;
  don't reintroduce one.
- **One install step, in the status line.** Context usage is the exception to
  the above: Claude Code hands a session's context percentage to the status
  line and nowhere else, so `~/.claude/statusline-command.sh` writes it to
  `~/.claude/ctx/<session id>.json` for the daemon to read. That block is
  quoted in `README.md`. If a machine has no status line, or the block is
  dropped, the gauge simply doesn't draw — never make a missing file an error.
  Don't be tempted by the transcript's `usage` totals instead: the percentage
  needs the model's window size (1M on some, 200k on others), which the
  transcript doesn't record.
- **Window focus must not disturb the window.** The current route (open a file
  the window already has open) was chosen because `code -r`, `open -a Code
  <folder>` and `vscode://` all either replace a window's content or spawn an
  extra one, and AXRaise needs Accessibility permission. The reasoning is in the
  comment above `focusWindow()` — read it before proposing an alternative.
- **MK.2 hardcoded-ish**: 15 keys, 72×72, macOS only, exclusive HID (the Elgato
  app cannot run alongside). The last two are reserved — key 14 (bottom-right)
  is the usage readout and the stats toggle, key 13 the attention key — leaving
  **13 session slots**. Extra sessions past that are dropped silently, by
  design.
- **A second press means "tell me more".** Tracked as a global "was the
  immediately preceding press this same key for this same session" check
  (`lastPress`), not a timeout, so any other key in between breaks the chain.
  First press focuses the window, second opens that session's detail board.
  Any press then leaves an overlay board, including the key that opened it —
  in the attention queue that press still focuses the window on the way out,
  which is the point of pressing one there; on the detail board its tiles have
  no window of their own, so they only dismiss. The press handler nulls
  `btn.assigned` itself the moment detail opens, rather than waiting for
  `refreshDetail`'s own nulling on its first poll (up to 2s later) — without
  that, the dismiss press still reads as "same key, same session" and the
  press after it reopens detail instead of focusing the window, purely
  depending on how fast you press.
- **Nested means spawned by another session, not "in a subdirectory".**
  `sessions.mjs` sets `nested: true` from `entrypoint`: `sdk-py`/`sdk-ts` is an
  agent some script started, `cli` is one you started yourself. `assignSlots`
  keeps nested ones off the board's slots; they group by folder onto the first
  button of that project's block as a small square coloured by their own state,
  and become readable tiles in two places — the attention queue if they block,
  and the detail board of their project, pinned to its tail.

  **This used to be inferred from the cwd**, and that was wrong. Anything below
  the window's folder was called nested, which caught the SDK helpers *and*
  every worktree — and most work in this setup happens in worktrees, so full
  agents were being hidden behind a marker built for background helpers. A cli
  session now gets a key wherever its cwd sits. The machinery that existed only
  to paper over the old rule is gone with it: `everReal` (which rescued a
  session that ran `EnterWorktree` mid-task) and orphan promotion (which
  rescued a folder whose only session had wandered into a worktree). A folder
  whose only sessions are nested now shows nothing, which is right — a key for
  one is exactly the phantom that once appeared for a security review nobody
  opened.
- **A key's caps bar is always the project name**, the matched window's
  folder — never the session's cwd. A worktree agent belongs to its project and
  says so, so two agents in one repo both read `KOB-TRACE` and are told apart
  by their body text, which is the field that actually differs between them.
- **"compacting" means the newest user line is a `/compact` command.** A
  manual `/compact` writes its command line into the transcript the moment it
  starts (bare `"/compact"` content or the `<command-name>` form — match the
  parsed content exactly, never the raw line, which tool results can contain),
  then writes nothing until the finished `compact_boundary` — so that line
  *is* the start marker, observed directly. The session must also say `busy`
  (clears the spinner the instant a `/compact` is canceled) and the marker
  must be younger than `COMPACT_MAX_S` (clears leftovers `busy` can't). The
  registry has no compaction field, the status-line payload has none, and
  auto-triggered compactions write no start marker at all — those are
  deliberately not detected. **Don't reintroduce the silence heuristic**
  ("busy + no pending tool + transcript quiet for 25s"): a turn thinking
  without a tool call is exactly as silent, so it false-fired on every long
  reasoning stretch. That shipped, and was replaced by the marker.
  `renderCompacting` draws a sweeping ring rather than a percentage, because
  no progress figure exists to draw — `pulse()` advances its phase a twelfth
  per tick and, as everywhere, never writes `btn.drawn`.
- **A key's colour covers its block; every other field is its own.** `refresh`
  takes `mostUrgent([own state, ...nested states])` for the background, so a
  project whose only activity is a subagent reads as working rather than
  sitting grey behind a 3×6px marker — subagents have no key, so this is the
  only way their state reaches one. The title, context gauge and task counter
  still describe the key's own session: a subagent can speak for "is anything
  happening here", not for "what is this key about". `state` is the block's, so
  `renderKey` takes a separate `shell` flag for the margin's blue dot; without
  it a key greened by a subagent would erase its own background-shell marker.

## Docs

- `README.md` — user-facing behaviour and the data sources table.
- `docs/superpowers/specs/2026-08-11-*.md` — original design, partly superseded
  (its hook-based status reporting is gone); kept as the record of how the
  design was reached.
- `docs/roadmap-reveal-terminal.md` — investigated-not-built: revealing the
  specific *terminal* inside a window needs a VS Code extension. Lists what was
  ruled out and why, so don't re-investigate the `code` CLI or `vscode://` URIs.
