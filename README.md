# claude-streamdeck

Shows active local Claude Code sessions on a dedicated Stream Deck MK.2 — one
button per session, with a stripe along the top identifying which VS Code
window it belongs to and, for sessions using tasks, a `done/total` count and
progress bar. Pressing a button focuses that window.

Key colour is the session's own status:

| Colour | Status | Meaning |
|---|---|---|
| green | `busy` | actively working |
| red | `requires_action` | blocked on you |
| amber | `waiting` | waiting on input |
| blue | `shell` | dropped to a shell |
| gray | `idle` | idle |

Design: `docs/superpowers/specs/2026-08-11-claude-streamdeck-monitor-design.md`

Roadmap: `docs/roadmap-reveal-terminal.md` — pressing a button raises the right
window but not the right *terminal* inside it. Investigated; needs a small
VS Code extension.

## Setup

1. `npm install`
2. Plug in the Stream Deck MK.2 (nothing else — no Elgato Stream Deck app —
   should be using it; this takes exclusive HID access).

No configuration, and nothing to install into Claude Code: everything is read
from files Claude Code already maintains under `~/.claude/`.

## Run

```
npm start
```

## Checks

```
npm run render-check   # SVG -> key image pipeline, writes a sample PNG
npm run slots-check    # project grouping / slot assignment
npm run tasks-check    # "task X of Y" numbering
```

## Where the data comes from

All read-only, all maintained by Claude Code itself:

| Path | Gives |
|---|---|
| `~/.claude/sessions/<pid>.json` | session id, cwd, name, **status**, liveness (pid) |
| `~/.claude/ide/*.lock` | which folders are open in VS Code windows |
| `~/.claude/projects/<cwd>/<id>.jsonl` | `aiTitle` — the title VS Code's terminal list shows |
| `~/.claude/tasks/<id>/*.json` | one file per task, with `status` → `done/total` |

## Notes

- **No hooks, no permissions, no config.** An earlier version wrote session
  state from Claude Code hooks into `~/.claude/settings.json`; the registry's
  own `status` field turned out to be both richer (it distinguishes
  `waiting` / `requires_action`) and free, so the hooks are gone.
- **No macOS permissions required.** Focusing a window opens a file from the
  target folder via LaunchServices; VS Code routes it to the window whose
  workspace contains it. Earlier attempts needed Accessibility ("control your
  computer", granted to the whole terminal app) — that's gone.
- **Focusing doesn't disturb the window.** It opens a file that window
  *already has open*, read from VS Code's own `state.vscdb`, so no tab is
  added and normally nothing visibly changes. If that state can't be read it
  falls back to a static anchor file (`package.json` and friends), which does
  switch the active editor.
- **Stripe colors** are assigned per VS Code window in first-seen order, so
  they stay put while running rather than reshuffling when a window appears.
- **"Task X of Y" follows the plan's own numbering.** A plan whose items are
  named `Task 4`..`Task 10` is eight files long, so its in-progress item is at
  list position 3 while everyone calls it task 6 — the subject numbers win
  when present, list position is the fallback. When nothing is in progress it
  shows the furthest completed task, so the pair never switches schemes.
- **Buttons are grouped by project.** All sessions for one VS Code window sit
  in a contiguous block sharing a stripe colour. This costs full stickiness:
  a new session inserts into its project's block, pushing later projects along
  by one. Both project order and within-project order are pinned to first-seen,
  so that insert is the only movement — nothing re-sorts by activity. A group
  can wrap across rows; blocks aren't padded to row boundaries.
