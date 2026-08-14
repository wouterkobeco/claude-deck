# claude-streamdeck

Your running Claude Code sessions, on a Stream Deck MK.2. One key per session,
coloured by what that session is doing right now; press a key to jump to its
VS Code window.

![The sessions board](docs/img/board-sessions.png)

Every key is one live session: the project name in caps along the top in that
project's colour, the session's own title under it, a `done/total` counter when
it's working through a task list, and a thin gauge along the bottom for how full
its context window is (green, amber past 50%, red past 85%, and once it's red
it breathes — about one slow cycle every 14s). Press a key to focus that
window.

| Colour | Status | Meaning |
|---|---|---|
| green | `busy` | actively working |
| red | `requires_action` | blocked on you — this key pulses |
| amber | `waiting` | waiting on input |
| blue dot | `shell` | dropped to a shell |
| gray | `idle` | idle |

The last two keys leave the rotation, so 13 are session keys. Extra sessions
past 13 are dropped.

- **Usage** (bottom-right) — how much of your session and weekly rate limits is
  spent. Press it for the stats board.
- **Attention** (next to it) — how many sessions are blocked on you and how long
  the worst one has waited. Dark and quiet when there's nothing to do.

The daemon is read-only: it polls the files Claude Code already writes under
`~/.claude/` every two seconds and redraws what changed. No hooks, no config
file, nothing written back.

## The other three boards

**Attention** — press the attention key for just the sessions that want you,
worst first. It re-sorts while it's up, and when the last one clears you're
dropped back to the normal board.

![The attention board](docs/img/board-attention.png)

**Detail** — press a second key of the same project in a row (the same key
twice counts) and that one session
takes over all 15 keys: its title across two keys, then state, context and
model, then its task list (done dimmed, in-progress bright), and pinned to the
end, the subagents it has running. `BACK` returns.

![The detail board](docs/img/board-detail.png)

**Stats** — the usage key's second press: time until each rate-limit window
resets, then all-time totals, and the daemon's own version. `BACK` returns, as
does the usage key.

![The stats board](docs/img/board-stats.png)

> The screenshots are rendered by `npm run board-shot`, which draws made-up
> sessions through the same code the daemon draws with.

## Nice details

- **Subagents don't get a key.** A session an SDK script started, or an agent a
  session spawned with the Agent tool, shows as a small square on its project's
  key, coloured by its own state, and becomes a readable tile on that project's
  detail board (and on the attention board, if it blocks). A session *you*
  started gets its own key wherever its cwd is — worktrees included.
- **A key's colour covers its block.** A project whose only activity is a
  subagent reads as working, not as a grey key with a 3px marker.
- **Slots never move.** Keys are assigned first-seen and stay put, and a project
  keeps its slot and colour after its last session ends, so a returning project
  lands where it was. The attention board is the deliberate exception — it's
  triage, not muscle memory.
- **`/clear` shows blank, not stale.** `/clear` reuses the transcript file, so a
  naive read keeps surfacing the pre-clear title. A cleared session with nothing
  said yet draws an empty body.
- **`idle` that's really "waiting for permission".** A turn that ends on a
  denied tool call reports as `idle` like any other. That case is detected from
  the transcript and promoted to `requires_action`.
- **Compacting reads as a sweeping ring**, not a percentage — nothing on disk
  reports how far along a compaction is.

## Setup

Requires macOS, Node 20+, and a Stream Deck MK.2 with nothing else using it
(the Elgato Stream Deck app cannot run alongside — this takes exclusive HID
access).

```
npm install
npm start
```

That's everything except the context gauge, which needs one block in your status
line: Claude Code reports a session's context percentage there and nowhere else.
Add this near the top of `~/.claude/statusline-command.sh` (assumes the usual
`input=$(cat)` first line):

```bash
ctx_dir="$HOME/.claude/ctx"
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ]; then
  mkdir -p "$ctx_dir"
  echo "$input" | jq -c '{context: .context_window.used_percentage}' > "$ctx_dir/$sid.json.tmp" &&
    mv "$ctx_dir/$sid.json.tmp" "$ctx_dir/$sid.json"
fi
```

Skip it and everything else still works; the gauge just never draws.

## Where the data comes from

All read-only, all maintained by Claude Code itself:

| Path | Gives |
|---|---|
| `~/.claude/sessions/<pid>.json` | session id, cwd, name, **status**, liveness (pid) |
| `~/.claude/ide/*.lock` | which folders are open in VS Code windows |
| `~/.claude/projects/<cwd>/<id>.jsonl` | the session title VS Code's terminal list shows, plus its model and reasoning effort |
| `~/.claude/tasks/<id>/*.json` | one file per task → `done/total` on the board, the full list on the detail board |
| `~/.claude/ctx/<id>.json` | context usage %, written by the status line block above |
| `api.anthropic.com/api/oauth/usage` | session / weekly rate-limit % — the only outbound call, authenticated with the CLI's own keychain token |
| `~/.claude/stats-cache.json` | all-time totals, for the stats board |

A session whose folder isn't open in a VS Code window is dropped: there'd be
nothing to focus.

## Checks

The test suite is a handful of plain scripts — no framework, no runner. Each
imports from `src/`, compares against expected values, and exits nonzero on
mismatch.

```
npm run render-check   # SVG -> key image pipeline, writes sample PNGs
npm run slots-check    # project grouping / slot assignment / detail layout
npm run tasks-check    # "task X of Y" numbering
npm run usage-check    # rate-limit parse (--live prints the raw API response)
npm run stats-check    # stats board formatting (--live prints the real tiles)
npm run title-check    # title / cleared / blocked-on-denial / model / effort
npm run board-shot     # re-render the screenshots above
```

## Known limits

- MK.2 only (15 keys, 72×72), macOS only.
- Pressing a key raises the right *window*, not the right *terminal* inside it —
  that needs a VS Code extension. See `docs/roadmap-reveal-terminal.md` for what
  was ruled out and why.
- Auto-triggered compactions aren't detected; only `/compact` is.

Design notes: `docs/superpowers/specs/2026-08-11-claude-streamdeck-monitor-design.md`
(partly superseded — its hook-based status reporting is gone).
