# Claude Stream Deck Monitor — Design

Date: 2026-08-11

## Problem

Multiple Claude Code sessions run at once across different VS Code windows/worktrees.
There's no at-a-glance way to see which sessions are working, idle, or waiting on
input without switching to each window. The goal: a dedicated Stream Deck MK.2 shows
one button per active local session, colored by state, and pressing a button brings
that session's VS Code window to the foreground.

## Scope

- Local interactive Claude Code sessions only (sessions with a live VS Code IDE
  connection). Cloud/Remote Control sessions are excluded — they have no local
  window to focus, so a button for one would only ever be a status light, not an
  action.
- Up to 15 sessions shown at once (one per MK.2 key), most-recently-active first.
  If more than 15 local sessions are running simultaneously, the 16th+ are simply
  not shown (dropped silently is acceptable here — this is a personal glanceable
  tool, not a completeness guarantee).
- Manual start (`npm start`) for now. No launchd autostart in this iteration.
- macOS only (uses `osascript`/AppleScript + System Events for window focus).

## Non-goals

- No support for other Stream Deck models in this iteration (MK.2 hardcoded:
  15 keys, 72×72 key images).
- No Windows/Linux support.
- No autostart/daemonization (launchd) yet.
- No coexistence with the official Elgato Stream Deck app — this takes exclusive
  HID access to the device by design (confirmed acceptable: device is dedicated
  to this use).

## Architecture

Three independent pieces, connected only through files on disk:

```
Claude Code sessions (any project)
        │  hook events (stdin JSON: session_id, cwd)
        ▼
~/.claude/hooks/streamdeck-status.sh
        │  writes
        ▼
~/.claude/session-status/<session_id>.json   { session_id, cwd, state, ts }
        │  read every ~2s
        ▼
claude-streamdeck monitor daemon (this new project)
        │  cross-references
        ▼
~/.claude/ide/*.lock                          { pid, workspaceFolders, ... }
        │
        ├─► renders key images (sharp, SVG→raster) → elgato-stream-deck (HID)
        └─► on keyDown → osascript (AppleScript) → raises matching VS Code window
```

### 1. Status reporter (hooks)

Add a `hooks` block to `~/.claude/settings.json` (global — currently has no `hooks`
key, confirmed safe to add) wiring these events to one shared script:

| Hook event        | Written state  |
|--------------------|---------------|
| `SessionStart`      | `idle`         |
| `UserPromptSubmit`  | `working`      |
| `PreToolUse`        | `working`      |
| `Notification`      | `needs_input`  |
| `Stop`               | `idle`         |
| `SessionEnd`         | *(delete file)* |

Script: `~/.claude/hooks/streamdeck-status.sh <state>`. Reads the hook's stdin JSON,
extracts `session_id` and `cwd` (via `jq`), and writes
`~/.claude/session-status/<session_id>.json` = `{session_id, cwd, state, ts}` where
`ts` is the epoch seconds at write time. On `SessionEnd` it deletes the file instead
of writing it.

Supports a `--self-check` flag: feeds itself a synthetic stdin payload, writes the
file, asserts its contents, then cleans up. Exit code signals pass/fail.

### 2. Monitor daemon

New Node project at `~/projects/claude-streamdeck`. On a ~2s interval:

1. Read every `~/.claude/session-status/*.json`. Skip files that fail to parse
   (stale/partial writes) without crashing.
2. Read every `~/.claude/ide/*.lock`, parse `workspaceFolders`.
3. Keep only sessions whose `cwd` is equal to, or nested under, some workspace
   folder from step 2 — this is the "local interactive only" filter, since only
   sessions with a live IDE connection have a `.lock` file.
4. Sort surviving sessions by `ts` descending (most-recently-active first).
5. Assign to key indices `0..14` in that order. Fewer than 15 sessions → remaining
   keys are cleared (blank/off).

### 3. Key rendering

For each assigned key: build an SVG (solid background rect colored by state —
`working` = green, `needs_input` = amber, `idle` = gray — plus the basename of
the matched workspace folder as centered text), rasterize with `sharp` to a
72×72 buffer, send via `elgato-stream-deck`'s fill-key API.

### 4. Button press → window focus

On `keyDown` for key index N: look up the session assigned to slot N (if any) →
its matched workspace folder's basename → run one `osascript` invocation:

```applescript
tell application "Visual Studio Code" to activate
tell application "System Events"
  tell process "Code"
    set targetWindow to first window whose name contains "<basename>"
    perform action "AXRaise" of targetWindow
  end tell
end tell
```

If no window matches (closed since the last poll), log to the daemon's console
and no-op — do not crash.

## Error handling

- Stream Deck device not found at startup: print a clear error, exit non-zero.
- Device unplugged while running: catch the disconnect, retry connecting on an
  interval until it reappears.
- Malformed/stale status JSON: skip that one file, keep processing the rest.
- AppleScript window lookup fails: log, no-op, continue polling.

## Testing

No test framework — this is a personal single-purpose tool. Two runnable checks:

- `render-check.mjs`: renders one sample key image to a PNG on disk, so the
  SVG→raster pipeline can be verified without the physical device attached.
- `streamdeck-status.sh --self-check`: verifies the hook script's own
  read-stdin → write-file logic in isolation.

## Open items deferred on purpose

- launchd autostart — add once the manual-start version has proven itself.
- Handling >15 concurrent local sessions — not expected in practice; revisit if
  it happens.
- Non-MK.2 hardware — out of scope until/unless the device changes.
