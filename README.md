# claude-streamdeck

Shows active local Claude Code sessions on a dedicated Stream Deck MK.2 — one
button per session, colored by state (green = working, amber = needs input,
gray = idle). Pressing a button focuses that session's VS Code window.

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
```
