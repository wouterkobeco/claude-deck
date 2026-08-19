# claude-streamdeck

Your running Claude Code sessions, on a Stream Deck MK.2. One key per session,
coloured by what that session is doing right now; press a key to jump to its
VS Code window.

![The sessions board](docs/img/board-sessions.png)

Every key is one live session: the project name in caps along the top in that
project's colour, the session's own title under it, a `done/total` counter when
it's working through a task list, and a thin gauge along the bottom for how full
its context window is (green, amber past 50%, red past 85%, and once it's red
it flashes red/white about once a second). Press a key to focus that
window.

| Colour | Status | Meaning |
|---|---|---|
| green | `busy` | actively working |
| red | `requires_action` | blocked on you — this key pulses |
| amber | `waiting` | waiting on input |
| green + blue dot | `shell` | turn's over, but a shell it started in the background is still running |
| gray | `idle` | idle |

The last two keys leave the rotation, so 13 are session keys. Extra sessions
past 13 are dropped.

- **Usage** (bottom-right) — how much of your session and weekly rate limits is
  spent. Press it for the stats board.
- **Attention** (next to it) — how many sessions are blocked on you and how long
  the worst one has waited. Dark and quiet when there's nothing to do.

Each project gets a colour bar naming it, and keeps that colour — across the
session and across restarts. It's remembered in
`~/.claude/streamdeck-accents.json`; delete that file and every project is
simply assigned a fresh colour the next time it's seen.

To choose the colours yourself, press the usage key for the stats board, then
the **⚙ CONFIG** key next to the back arrow. A page opens in your browser
listing every open project; pick one of the eight accents and the deck updates
within two seconds. If another open project already wears it, the two swap —
so no two projects on the board are ever the same colour. The page is served
by the daemon on localhost, only while it's running, and only reachable with
the token in the URL it just opened.

The page's **Activity** tab is everything a 72px key can't carry:

- **Output tokens per hour**, last 24 hours, and the same split by model.
- **Sessions at once**, the peak per hour, coloured by what they were doing.
  Open is not the same as working, and this is the difference. An hour the
  daemon wasn't running is drawn striped rather than empty — a sleeping
  machine and an idle one both produce silence, and they must not look alike.
- **Where the time went**: time each project spent working, waiting, and
  blocked on you, today and over the last 7 days.

The state history is `~/.claude/streamdeck-history.jsonl`, kept 30 days; the
token totals are `~/.claude/streamdeck-tokens.jsonl`, kept a year. That second
one exists because Claude Code deletes its own transcripts after 30 days
(`cleanupPeriodDays`), so the numbers have to be copied out while they're
there. Both are read-only history — delete either and the charts start again
from empty. Today's total blocked time also gets a tile on the stats board.

The same page reorders the board. Drag a project by its **⠿** handle and drop
it where you want; a line shows where it will land. Topmost is the first block
on the deck — top-left key — and a project's sessions always stay together in
one block, so you're only ever ordering projects. Anything you haven't dragged
keeps arriving in the order it first appeared, and the order survives restarts
alongside the colours.

The daemon is read-only: it polls the files Claude Code already writes under
`~/.claude/` every two seconds and redraws what changed. No hooks, no config
file, nothing written back except its own notes to itself and to the VS Code
extension.

## The other three boards

**Attention** — press the attention key for just the sessions that want you,
worst first. It re-sorts while it's up, and when the last one clears you're
dropped back to the normal board.

![The attention board](docs/img/board-attention.png)

**Detail** — press a session's key, then press it again, and that one session
takes over all 15 keys: its title across two keys, then state, context (a ring,
in the same green/amber/red as the gauge) and
model, then its task list (done dimmed, in-progress bright), and pinned to the
end, the subagents it has running. `BACK` returns. What counts as "again"
depends on the extension — see Known limits.

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
- **A key uses the whole key.** Lines are filled to the width they really
  reach — character widths are measured off the same font the keys are drawn
  in, rather than guessed at one average width per character — and the left
  marker column is held open only while a marker is in it, so a key with no
  background activity gets those pixels for its title instead.
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

`.npmrc` sets `loglevel=silent`, so `npm start` prints the daemon's own line
and nothing else. Everything this project prints still comes through, errors
included — the one thing it hides is npm's own reporting, so if an install
looks wrong, run `npm install --loglevel=warn` to see why.

That's everything. The context gauge needs one block in your status line —
Claude Code reports a session's context percentage there and nowhere else — and
`npm start` checks for it and offers to add it, defaulting to yes. It writes a
whole status line if you have none, inserts the block after `input=$(cat)` if
you do (keeping a `.bak`), and describes the block instead of touching anything
if your status line is something it can't reason about. `npm run
statusline:install` does the same without the question.

The block, if you'd rather add it by hand — near the top of
`~/.claude/statusline-command.sh`, after the usual `input=$(cat)` first line:

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

### Reveal the right terminal

Raising a window is only half the job when several sessions share it — the
terminal showing may be another session's. A small VS Code extension in this
repo fixes that: pressing a key reveals that session's terminal, bringing a
joined split group forward with the right pane active.

`npm install` already installed it — `postinstall` copies `extension/` into
`~/.vscode/extensions`. `npm run ext:install` does the same thing on its own if
you want it without a full install.

**One manual step remains, and it's the one people miss:** run
`Developer: Reload Window` in each VS Code window that was already open. New
windows pick the extension up on their own, but an open one keeps running
whatever it loaded at startup — after an upgrade that means the *old* code,
with no sign that anything is stale. Terminals survive the reload, though it's
worth proving that on a scratch window before doing it to one with real work in
it.

Without the extension — or before that reload — everything else works exactly
as before: the window is raised and the terminal is left alone.

### Restore your sessions after a VS Code restart

Quit VS Code and the terminals go with it, taking every Claude session running
in them. The same extension can put them back: **Claude Stream Deck: Restore
Claude sessions in this window**, from the command palette. It offers the
sessions this window had open, all ticked; each one you keep gets a terminal in
its own working directory running `claude --resume <id>`.

The list is remembered while the daemon is running — Claude Code deletes a
session's registry entry the moment it exits, so after the restart there is
nothing left to read. Remote-SSH windows are included, because the daemon
already fetches their sessions over ssh; in practice those often survive a local
restart on their own, and the command then correctly offers nothing.

Sessions still running are never offered, so a plain `Developer: Reload Window`
(where terminals survive) shows an empty list rather than opening duplicates.

## Where the data comes from

All read-only, all maintained by Claude Code itself:

| Path | Gives |
|---|---|
| `~/.claude/sessions/<pid>.json` | session id, cwd, name, **status**, liveness (pid) |
| `~/.claude/ide/*.lock` | which folders are open in VS Code windows |
| `~/.claude/projects/<cwd>/<id>.jsonl` | the session title VS Code's terminal list shows, plus its model and reasoning effort |
| `~/.claude/tasks/<id>/*.json` | one file per task → `done/total` on the board, the full list on the detail board |
| `<repo>/.superpowers/sdd/<plan>/` | fallback for a session whose tasks Claude Code isn't tracking: superpowers' SDD ledger, read only when the above is empty and only for a local session |
| `~/.claude/ctx/<id>.json` | context usage %, written by the status line block above |
| `api.anthropic.com/api/oauth/usage` | session / weekly rate-limit % — the only outbound call, authenticated with the CLI's own keychain token |
| `~/.claude/stats-cache.json` | all-time totals, for the stats board |
| `ssh <host> ~/.claude/{sessions,ide,tasks,projects}` | a Remote-SSH window's own sessions — name, state, title, tasks and subagents, everything above except the context gauge |

A session whose folder isn't open in a VS Code window is dropped: there'd be
nothing to focus.

A VS Code window opened through Remote-SSH runs `claude` on the remote host, so
its registry, IDE lock and transcripts live in *that* machine's `~/.claude/`,
fetched over `ssh` rather than read from disk. Its key shows everything a local
key does, context gauge included — but the gauge needs the status line block
above on **that** machine, because the percentage exists nowhere else. Install
it with:

```
npm run remote:install -- <host>
```

which copies your own status line there (or a minimal one, if you have none)
and points the remote's `settings.json` at it. It refuses rather than
overwrites: a host that already has a status line, or already sets `statusLine`,
is left alone and told what to add by hand. This is the only thing here that
writes to a machine other than yours, which is why it is a command you run
rather than anything the daemon does — and why it is deliberately not part of
`npm install`. Pressing a remote key works like pressing a local one: the first
press raises that VS Code window and reveals the session's own terminal in it,
the second opens the detail board. The raise goes through the `code` CLI rather
than `open`, because a remote window's documents are `vscode-remote://` URIs.
A remote window also needs its own one-time step: it
must be reloaded once after upgrading before it publishes which host it's on,
same as the terminal-focus extension version above.

## Checks

The test suite is a handful of plain scripts — no framework, no runner. Each
imports from `src/`, compares against expected values, and exits nonzero on
mismatch.

```
npm run render-check    # SVG -> key image pipeline, text fitting, sample PNGs
npm run slots-check     # project grouping / slot assignment / detail layout
npm run tasks-check     # "task X of Y" numbering, and the SDD ledger fallback
npm run usage-check     # rate-limit parse (--live prints the raw API response)
npm run stats-check     # stats board formatting (--live prints the real tiles)
npm run title-check     # title / cleared / blocked-on-denial / model / effort
npm run subagents-check # which Agent-tool subagents are still running
npm run colors-check    # palette contrast + separation floors
npm run terminal-focus-check # pid-ancestry walk + newest-press-wins guard
npm run vscode-state-check   # which window's storage answers for a folder
npm run remote-install-check # what remote:install decides before it writes
npm run extension-check      # whose window a focus request is for
npm run remote-check    # remote source: host validation, tar/tail framing, matches a local source's output
npm run board-shot      # re-render the screenshots above
```

## Known limits

- MK.2 only (15 keys, 72×72), macOS only.
- Auto-triggered compactions aren't detected; only `/compact` is.
- **Terminal focus needs the extension installed** — see "Reveal the right
  terminal" under Setup, above. Without it, a press still raises the right
  window but leaves the terminal inside alone, exactly as before this
  feature, and a second press on any key of a project opens the detail board.
  With it, a press also reveals the session's own terminal, so pressing a
  *different* session's key switches to that terminal instead of opening
  detail — only a repeat press on the same session does that now. Windows
  reloaded and not-yet-reloaded therefore behave differently until every
  window has been reloaded once.
  With **two windows open on the same folder**, a press can raise one window
  while revealing the terminal in the other: the extension routes by process
  id and gets it right, but the window raise opens a file and macOS picks the
  window. Nothing outside the editor can aim that raise at a specific window.

Design notes: `docs/superpowers/specs/2026-08-11-claude-streamdeck-monitor-design.md`
(partly superseded — its hook-based status reporting is gone).
