# claude-streamdeck

Shows active local Claude Code sessions on a dedicated Stream Deck MK.2 — one
button per session, colored by state (green = working, amber = needs input,
gray = idle), with a stripe along the top identifying which VS Code window the
session belongs to. Pressing a button focuses that window.

Design: `docs/superpowers/specs/2026-08-11-claude-streamdeck-monitor-design.md`

## Setup

1. Hooks are already wired into `~/.claude/settings.json` (global), pointing at
   `bin/streamdeck-status.sh`. Confirmed live: they fire for already-running
   sessions too, not just ones started after the hooks were added.
2. `npm install`
3. Plug in the Stream Deck MK.2 (nothing else — no Elgato Stream Deck app —
   should be using it; this takes exclusive HID access).

## Run

```
npm start
```

## Checks

```
npm run self-check     # hook script's read-stdin -> write-file logic
npm run render-check   # SVG -> key image pipeline, writes a sample PNG
npm run slots-check    # sticky button slot assignment
```

## Notes

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
- **Buttons are grouped by project.** All sessions for one VS Code window sit
  in a contiguous block sharing a stripe colour. This costs full stickiness:
  a new session inserts into its project's block, pushing later projects along
  by one. Both project order and within-project order are pinned to first-seen,
  so that insert is the only movement — nothing re-sorts by activity. A group
  can wrap across rows; blocks aren't padded to row boundaries.
