# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start              # run the daemon (needs the Stream Deck plugged in)
npm run render-check   # SVG -> RGBA pipeline; writes scripts/render-check-output.png
npm run slots-check    # project grouping / slot assignment
npm run tasks-check    # "task X of Y" numbering
npm run usage-check    # rate-limit parse (add --live to print the raw API response)
```

The checks are the test suite: plain `node scripts/*-check.mjs` files that
import from `src/`, compare against expected values, and `process.exit(1)` on
mismatch. No framework, no runner — run one by running its script. New
non-trivial logic gets a case appended to the matching check, or a new
`scripts/<thing>-check.mjs` in the same style.

## Architecture

A single polling daemon, ~950 lines across six modules. Every 2s it rebuilds
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
  a poll can land mid-write. `readLatestAiTitle` also stops that scan at the
  most recent `/clear` — see the invariant below.
- `src/index.mjs` — daemon loop, slot assignment, focus. Exports `assignSlots`
  and `accentFor` for the checks; the `import.meta.url === argv[1]` guard at the
  bottom is what keeps importing it from starting a daemon. Also owns the
  session/stats view toggle (`statsMode`, local to `run()`) — pressing the
  usage key flips it; the other 14 buttons redraw as sessions or stat tiles
  depending on which is current. The stats board's top-left pair ("Session
  reset in" / "Week reset in") isn't from stats.mjs — it's `usage.mjs`'s
  `sessionResetsAt`/`weekResetsAt` reduced to hours/days, prepended in
  `index.mjs` because they change by the hour/day while the all-time totals
  barely move.
- **`/clear` reuses the transcript file.** It's written as an ordinary line
  (`<command-name>/clear</command-name>`) into the same `.jsonl`, not a new
  file, so a naive backward scan for `aiTitle` would keep surfacing the
  pre-clear summary. `readLatestAiTitle` stops at the most recent `/clear`
  instead; if nothing's been said since, it reports `clearedEmpty: true` and
  `index.mjs` shows a blank body rather than falling back to the session name
  or cwd — those would look like a real answer when the honest one is
  "nothing yet".
- **Requires-action keys pulse.** `pulse()` in `index.mjs` is a second loop
  alongside the main poll, ticking every `PULSE_MS` (400ms) — the 2s poll is
  far too slow to read as animation. It redraws only `requires_action` keys,
  reusing `btn.renderParams` (cached every poll in `refresh()`, not just on
  change) rather than re-deriving from a fresh session read. It never touches
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
- **Redraw is diffed** on the `btn.drawn` signature string in `refresh()`. Any
  new visual input must be added to that string or it will not appear until
  something else changes.
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
  app cannot run alongside). Extra sessions past the key count are dropped
  silently, by design.

## Docs

- `README.md` — user-facing behaviour and the data sources table.
- `docs/superpowers/specs/2026-08-11-*.md` — original design, partly superseded
  (its hook-based status reporting is gone); kept as the record of how the
  design was reached.
- `docs/roadmap-reveal-terminal.md` — investigated-not-built: revealing the
  specific *terminal* inside a window needs a VS Code extension. Lists what was
  ruled out and why, so don't re-investigate the `code` CLI or `vscode://` URIs.
