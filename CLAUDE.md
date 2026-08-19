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
npm run title-check    # aiTitle / clearedEmpty / blockedOnDenial / model / effort
npm run subagents-check # which Agent-tool subagents are still running
npm run colors-check   # palette contrast + separation floors
npm run terminal-focus-check # pid-ancestry walk + newest-press-wins guard
npm run vscode-state-check   # which window's storage answers for a folder
npm run extension-check      # whose window a focus request is for
npm run remote-install-check # what remote:install decides before it writes
npm run config-check   # config server: token gate, validation, HTML escaping
npm run statusline-check     # what `npm start` decides your status line needs
npm run statusline:install   # add the context-gauge block here, no question
npm run history-check  # state log: change-only records, durations, retention, concurrency
npm run tokens-check   # token extraction: incremental reads, grouping, compaction
npm run remote:install -- <host>  # status line on a remote host, for its gauge
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
(listed below — the count isn't pinned here so this sentence doesn't go stale
every time one is added). Every 2s it rebuilds the whole board from disk;
there is no event stream and no persisted state.

```
~/.claude/{sessions,ide,projects,tasks}   →  sessions.mjs  →  getLiveSessions()
ssh <host> ~/.claude/…              → remote-fs.mjs  ↗              ↓
                                              index.mjs: assignSlots + diff + draw
                                                            ↓              ↓
                                          render.mjs (SVG→RGBA)      Stream Deck
button press → index.mjs → vscode-state.mjs (already-open file) → `open -a "Visual Studio Code"`
                        ↘ terminal-focus.mjs → ~/.claude/streamdeck-focus.json → extension/ → terminal.show()
```

- `src/sessions.mjs` — the only reader of Claude Code's state, read through a
  *source*: `{ host, root, isAlive, tail }`. `getLiveSessions(sources =
  [localSource()])` runs the same body over every source and concatenates the
  result; `localSource(root?)` is today's behaviour with a name, so the
  default argument is the whole of what changed for a machine with no remote
  hosts. A remote host supplies nothing more than those three things — where
  its tree landed after `remote-fs.mjs` fetched it, membership in a pid list
  fetched alongside it instead of `process.kill`, and a tail read over ssh
  instead of a local file — because every path in this module already derives
  from one root (`CLAUDE_DIR`, or a source's `root`), so that's the entire
  host-dependent surface — everything between a source going in and sessions
  coming out (matching, enrichment, subagent synthesis) is the same code
  either way. It joins the
  session registry against open VS Code workspace folders (a session with no
  local window is dropped), then enriches with `aiTitle` (tail-scanned from the
  transcript jsonl), task progress, and context usage. Every file read is wrapped in try/catch
  that skips rather than throws: these files are written by another process and
  a poll can land mid-write — a source's `isAlive`/`tail` are someone else's
  code (an ssh-backed source can throw where a local read only fails), so
  `getLiveSessions` itself wraps each source's `sessionsFrom` call so one bad
  host drops only its own keys rather than the whole board. `readTranscriptSignals` reads `aiTitle` and two
  more things from that same tail scan — see the two invariants below.
- `src/remote-fs.mjs` — fetches one remote host's small files and transcript
  tails over `ssh`, assuming nothing on the other end but a POSIX shell: no
  collector script, no interpreter, because `sessions.mjs` already computes
  every path it needs from the registry it fetches first (an earlier draft of
  this spec shipped a Python collector before that was noticed). Two calls.
  `TREE_CMD` tars `sessions/`, `ide/`, `tasks/` and every non-transcript file
  under `projects/`, with the member list built by piping `find` through an
  anchored BRE rather than `tar --exclude`: `--exclude` matches with `fnmatch`
  and no `FNM_PATHNAME`, so `*` crosses `/` — a `projects/*/*.jsonl` exclude
  also drops the depth-four subagent transcripts, and the only symptom is that
  no remote session ever shows a subagent. Measured against a real host: 20KB
  fetched with the anchored list, 4.7MB without. `TAILS_CMD` reads exactly the
  transcripts `sessions.mjs`'s own path functions ask for, NUL-delimited with
  no length prefix — an earlier version sent `wc -c` then `tail -c`, two reads
  of a live file, so a sub-64KB transcript that grows between them made the
  reader take the surplus as the next file's opening bytes; `whole` now comes
  from the bytes actually received, not a separate count. `swapTree` extracts
  into a scratch directory and renames it over the previous one rather than
  letting `tar -xf` merge: a merged tree keeps what the remote deleted, so a
  closed window's `ide/*.lock` would linger and keep `matchFolder` matching a
  folder with no window — the exact invariant the whole join exists to
  enforce.
- `src/remote-hosts.mjs` — which hosts are due for a fetch this tick, and what
  to hand the board for the rest: `dueHosts`, `remoteSources`,
  `cachedSources`. Remote hosts poll slower than local — `REMOTE_POLL_MS` (6s
  against the daemon's 2s) — because two ssh round trips every 2s plus a held
  `ControlPersist` connection is a constant background load on a machine doing
  its own work, here a Raspberry Pi running home automation; nothing on a
  remote key changes faster than it can be read, so the slower cadence costs
  nothing visible. Consecutive failures back off 5s → 10s → 30s and one
  success resets, the shape `usage.mjs` already uses for 429s.
  `STREAMDECK_NO_REMOTE=1` skips every remote source — every other risky
  reader here degrades to nothing by itself, and this is the one holding an
  open connection to another machine, so it gets an explicit off switch.
  **A failing host used to vanish silently**, and that was the one dishonest
  thing on the board: a failed fetch leaves `source: null`, `cachedSources`
  filters it out, and its keys disappear exactly the way a closed window's do.
  `unreachableHosts` says so instead, and what makes that possible is that a
  remote window's extension host runs *locally* (`extensionKind: ["ui"]`), so
  `readWindowStates()` still knows that host's windows and folders while ssh is
  dead — the information was always there and was being discarded. It reports
  one entry per *folder*, so each stand-in key lands in the block slot its
  project already held, and it keys them so a folder open in two windows on one
  host is one key rather than two on the same slot. It tests `failures`, not
  `source == null`: a host never fetched also has no source, and "not yet" is
  not "unreachable". `failingSince` is stamped once at the transition into
  failure and cleared on success — `lastAt` would answer "how long since the
  last retry", which is always about zero and says nothing.
  **`cachedSources` is what the poll loop actually reads, every 2s — no fetch,
  no await.** A fetch is two *sequential* ssh calls, each bounded by its own
  15s hard kill, so awaiting one inline stalls a tick by up to ~30s — pausing
  every key's redraw, local ones included, because one other machine went
  quiet. A bounded stall is still a stall; `remoteSources` starts the fetch and
  the poll draws whatever the last one produced, at the cost of one poll of
  staleness the first time a remote window appears. Freshness, never frames.
  **The in-flight guard is load-bearing, not hygiene**: `lastAt` is stamped
  when a fetch *finishes*, so without an explicit in-flight claim a slow fetch
  stays "due" for its whole duration and the next tick would start a second
  one against the same staging directory and ControlPath; eviction likewise
  skips an in-flight entry, or a window closing and reopening mid-fetch — a
  reload, which this project treats as routine — would strip the guard out
  from under a fetch that is still running.
- `src/index.mjs` — daemon loop, slot assignment, focus. Exports `assignSlots`,
  `accentFor`, `attentionQueue` and `detailLayout` for the checks; the
  `import.meta.url === argv[1]` guard at the bottom is what keeps importing it
  from starting a daemon. Also owns **which board is showing**: one `view`
  value local to `run()`, never a flag per board, so "stats and detail are both
  somehow on" isn't representable. Its five kinds — `sessions`, `stats`,
  `attention`, `free`, `detail` — each have one branch in the poll loop and one
  `refresh*` function, and the same 12 session keys are redrawn by whichever is
  current. The `drawn`-signature diffing does the switching for free: signatures
  never match across boards, so a mode change redraws everything once and needs
  no explicit invalidation. The stats board's top-left pair ("Session reset" /
  "Week reset") isn't from stats.mjs — it's `usage.mjs`'s
  `sessionResetsAt`/`weekResetsAt` reduced to hours/days, prepended in
  `index.mjs` because they change by the hour/day while the all-time totals
  barely move. Its last tile is the daemon's own version, appended in
  `index.mjs` for the same reason — `pkg` is already read there. It also gets a
  back key at `DETAIL_BACK_INDEX`, like the detail board, but *assigned* at
  that index rather than spliced: an unreadable stats cache makes the tile list
  short, and the way out still has to be on the bottom-left button.
- **One session across the whole deck: the detail view.** A second press on a
  session key (see the repeat-press rule below) opens `refreshDetail`, which
  takes over **all 15 keys** — usage and attention included, unlike every other
  board, which draws only the 12 session keys. `detailLayout` lays out a
  the session's own key again — same label, same caps bar, `keyFields` verbatim,
  so the key you pressed is the key you land on; it was split across two keys
  first, which said the same thing twice and cost a task slot —
  STATE/CONTEXT/MODEL stat tiles (CONTEXT passes `pie` to
  `renderStat`, which draws a ring in `usageColor` instead of the value text —
  the number keeps the hole but drops its `%`, which is what the ring says and
  what stops "100" fitting), then that session's task list
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
- **A key whose host went away says so; it does not disappear.** `refresh`
  synthesises one stand-in "session" per unreachable folder
  (`unreachableTiles`) and passes it to `assignSlots` **there and nowhere
  else** — deliberately not through `liveSessions()`. It must not reach
  `publishSessions` (the restore command would try to `claude --resume` an id
  nothing can resume), `liveProjects` (the config page would list a project
  that isn't running), or `attentionQueue` (nothing here is blocked on you).
  It carries the real folder and host, which is exactly what earns it the
  block's own slot and accent: `folderKeyFor` and `folderOrder` treat it as the
  missing sessions were treated, so the key appears where it always was. Drawn
  grey rather than red — `CLAUDE.md` reserves the pulse for things blocked on
  you — which means the *word* on the key is what tells it apart from an idle
  session, and that word is `offline` rather than the accurate `unreachable`
  because `renderKey` fills lines by character and eleven letters broke as
  "pi unreac / hable 4m" on the raster. `renderParams` is nulled on that
  branch, like every other board that isn't the session view, so `pulse()`
  never redraws a key this branch owns from stale data.
- **Nothing in a transcript line may be matched as a raw substring.** A
  transcript stores tool results verbatim, so a session that greps this repo or
  prints another transcript writes `<command-name>/clear</command-name>`,
  `toolDenialKind` and `"type":"user"` into its own tail *as text* — on
  `type:"user"` lines, because a tool result rides on the user turn. Every
  marker in `readTranscriptSignals` is therefore a cheap pre-filter only, and
  nothing is believed until that line's own parsed JSON says so: `type` from
  the top level, a command from `message.content` *starting* with its tag,
  `toolDenialKind` as a field. The `/compact` detection was written this way
  from the start; `/clear` and `blockedOnDenial` were not, and this project's
  own key spent a session reading CLEAR because of it.
- **`/clear` reuses the transcript file.** It's written as an ordinary line
  (`<command-name>/clear</command-name>`) into the same `.jsonl`, not a new
  file, so a naive backward scan for `aiTitle` would keep surfacing the
  pre-clear summary. `readTranscriptSignals` stops at the most recent `/clear`
  instead; if nothing's been said since, it reports `clearedEmpty: true` and
  `index.mjs` shows a body of `CLEAR` rather than falling back to the session
  name or cwd — those would look like a real answer when the honest one is
  "nothing yet". `renderKey` draws that word for any empty body, so the same
  key can't be blank in one place and named in another.
  **A session that was never typed into says the same thing**, reached the
  other way: `startedEmpty`. Claude Code writes a transcript the instant a
  session opens (a mode line, a snapshot, any SessionStart hook output — all
  `type:"attachment"`), so the file's existence proves nothing; the first
  `type:"user"` line is the human's first prompt. That absence only counts
  when `tailLines` reports `whole` — its window reached byte 0 — because "no
  user line in the last 64KB" is equally true of a long session mid tool-call
  stretch. Every other signal in that scan stops at its first hit going
  backwards, which a tail can only help; this is the one that has to know it
  saw the whole file.
  **Those two flags are the only things allowed to blank a body, and nothing
  below them may fill it.** The rungs under `aiTitle` all describe the session
  rather than the conversation — `lastPrompt`, then a name Claude Code derived
  from the cwd (`kob-portal2-01`), then the cwd — so `keyFields` reads as one
  chain, but the two directions of error are not symmetrical: a session nobody
  has spoken to *must* read CLEAR, and a session that is **working** must never
  read it. Both halves have now been wrong on this machine's own deck within one
  day, in opposite directions, from the same edit.
  **`lastPrompt` is the rung that carries the early session**: `aiTitle` doesn't
  exist for the first turn or two, and roughly one session in sixteen here never
  gets one at all (measured: 41 of 693 transcripts in one project), so without
  it a key spends that time showing a placeholder derived from the folder it is
  already captioned with. It's the newest thing the *human* typed, off the same
  tail scan, and almost no `type:"user"` line qualifies: a tool result rides on
  the user turn (content is an array of blocks), and Claude Code injects its own
  — skill bodies, command output, the local-command caveat — marked `isMeta`.
  **`isMeta` doesn't catch all of them**: a `<task-notification>` for a finished
  background agent is an unflagged string user line of pure markup, and it drew
  its own tags on a live key, so anything opening with a tag that isn't a
  command is treated as Claude Code talking to itself. That rejection has to
  leave the search *unresolved* rather than answer null — otherwise one
  notification hides the prompt sitting right behind it. A slash
  command is stored as its own markup and is unwrapped to the command (plus its
  args), because the tags would fill the key with angle brackets; `/clear` needs
  no case of its own, since it *is* one of these lines and so stops the search
  before it can reach the conversation that was thrown away.
  **What it cannot do is reach past the tail.** A session that has been working
  for twenty minutes has pushed its prompt out of the last 64KB, and if it also
  never got an `aiTitle` its key falls all the way back to the derived name —
  the one case this rung was added for that it does not fix. The prompt is at
  the *head* of the file, and a source's contract is `tail`; reaching it means
  either a local-only read (breaking "the same code either way") or heads in
  `remote-fs.mjs`'s second call, whose framing has already been got wrong once.
  Left undone deliberately.
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
  flashing on them — `requires_action` keys, keys carrying nested markers, keys
  whose context gauge has gone red, and the attention key when its count is
  nonzero — reusing `btn.renderParams` (cached every poll in
  `refresh()`/`drawAttention()`, not just on change) rather than re-deriving
  from a fresh session read. It never touches `btn.drawn`, so the next
  `refresh()` still recognises a steady frame as unchanged and leaves the
  button alone.
  **The beats are deliberately different speeds**, because they say different
  things: `requires_action` alternates every tick (0.8s) because it's blocked
  on you *now*, the compaction ring turns once every ~5s, and a red context
  gauge flips red/white every other tick (`tick % 4`, so ~0.8s a colour) —
  half the requires_action beat, so the two don't read as one alarm.
  `gaugeColor` flashes red *brighter*, never dimmer: the gauge is 3px on a
  near-black track held to a contrast floor, and dropping below that floor for
  half of every cycle is a gauge that keeps vanishing. Phase 0 is exactly
  `usageColor`, so every board that doesn't pulse draws what it always did.
  **Two gradual versions shipped before this one and neither was visible on
  the deck** — a pink cosine over 14s, then a white one over 7s, both passing
  `colors-check`. 3px of line is too little to carry a gradient: most of a fade
  is spent in the middle, looking like one steady colour. Hence a square wave,
  and hence the ΔE floor there is 40 rather than 20 — "obvious side by side"
  isn't the bar for a line this thin seen across a room.
  The breath also **replaced** the gauge's second channel: red used to draw at
  4px (`gaugeHeight`, now gone) because colour alone is weak at 72px across a
  room. Motion carries further than either, so the height is flat again — two
  signals for one fact, and the thicker one spilled onto the key's background.
- `src/render.mjs` — builds an SVG string per key and rasterizes with sharp.
  Pure: takes geometry + data, returns a buffer. Text fitting is hand-rolled
  character-width estimation, so layout changes need `render-check` looked at,
  not just run. **`CHAR_WIDTH` is measured off this pipeline's own raster**, not
  copied from a font spec: `sans-serif` at weight 600 resolves to Helvetica Bold
  here, `wrapLabel` fills each line to the width it really reaches, and
  `render-check` renders a sample and asserts the estimate lands within a band
  of the ink it covers — so a table that drifts from the installed font fails
  rather than silently over- or under-filling every key. A line's budget must be
  measured from where the text actually starts (`width - textLeftX - 3`, not
  `width - marginWidth`); the flat 0.6em estimate this replaced was wrong in
  both directions at once and hid that. The marker column is reserved only
  while a marker is in it — an empty one is a seventh of the line — so the body
  starts at x=11 on a key with nested activity and x=3 on one without, which
  `render-check` reads back off the raster rather than trusting the arithmetic. **The palette is three tiers separated by lightness** —
  `STATE_COLORS` fill a whole key and stay dark (L\* 36–47), `ACCENTS` are the
  light identity bar (57–94), `MARKER_COLORS` and the usage gauge are a few
  bright pixels drawn on top. Everything small is light-on-dark; that one rule
  is why white body text, 3×6px markers and a 3px gauge all stay readable on
  fifteen keys in four states. `colors-check` asserts the floors, so a hex
  nudged to taste can't quietly make one marker invisible on one key in one
  state — which is otherwise only findable by looking at that key, in that
  state, on the actual deck. Two floors there are deliberately lower than the
  rest and say so in comments: red markers (red is the darkest hue, and light
  enough to clear the others converges on the white idle square) and the gauge,
  which is checked against the dark track it's inset onto rather than the
  accent it would otherwise vanish into.
- `src/usage.mjs` — the two rate-limit windows for the bottom-right key. These
  numbers exist only server-side, so it reads the CLI's own OAuth token from the
  login keychain and asks the API, cached 5 minutes. The only outbound network
  call in the project, and the only credential it touches. **That endpoint is
  shared, and it 429s you for other clients' traffic.** Every Claude Code
  session on the machine polls it with the same token; measured over 21
  requests at a strict 1/min, 19% came back 429 — including the first request
  from a cold process. It sends no ratelimit headers and answers
  `retry-after: 0`, so there is nothing to obey: each consecutive 429 waits one
  TTL longer (5m, 10m, 20m, capped at 30m) and one success drops back to the
  plain TTL. Don't shorten the TTL to make the key livelier — these are 5-hour
  and 7-day windows, and the cost of asking more often is paid in 429s. Set
  `USAGE_LOG=1` to append one line per request (timing, status, headers, live
  session count) to `~/.claude/streamdeck-usage.jsonl` before changing any of
  this.
- `src/stats.mjs` — all-time stats board (favorite model, total tokens,
  sessions, ...), read from `~/.claude/stats-cache.json`, cached 30s. Values are
  validated against a real screenshot of the source tool's own output; don't
  change the formatting helpers without re-checking against a real cache file.
  It returns exactly seven tiles — `index.mjs` brackets them with the reset
  pair, the version tile, the back key and the config key to fill all 12
  buttons, so an eighth
  would land under the back key and never be seen (`stats-check` pins the
  count).
- `src/vscode-state.mjs` — best-effort reader of VS Code's `state.vscdb` via the
  `sqlite3` CLI, to find a file the target window already has open. Reads an
  undocumented internal format, so *every* failure path returns `null` and the
  caller falls back to a static anchor file. Never make this throw.
  **A remote window is found under a different URI and answers with a different
  thing.** Its `workspace.json` records
  `vscode-remote://ssh-remote%2B<host><path>` rather than `file://<path>` — note
  the percent-encoded `+` — and its editors carry the encoded URI in
  `external`, which is returned verbatim rather than rebuilt, because the raise
  goes through `code --file-uri` and re-encoding an authority by hand is a bug
  waiting to happen. The authority is checked rather than assumed: one folder's
  storage can outlive it being reopened against a different host, and raising
  the wrong host's window is the confusion `folderKeyFor` prevents a layer up.
  **`storageDirFor` only ever matches a window's `folder`**, and a multi-root
  window records a `workspace` instead — so it finds nothing for those, which is
  why the remote branch of `focusWindow` skips the raise rather than guessing
  with `--folder-uri`.
- `src/terminal-focus.mjs` — asks the VS Code window that owns a session's
  terminal to reveal it. The join is process ancestry: `Terminal.processId` is
  the shell's pid and Claude is a descendant of it, so the daemon writes the
  session's whole ancestor chain to `~/.claude/streamdeck-focus.json` and the
  extension picks the terminal whose pid is in it. **The request is
  self-routing** — every window reads the same file and only the one owning a
  match acts, which is why there is no port file, no token and no window
  addressing here, unlike `~/.claude/ide/*.lock`. `issued` is not decoration:
  `requestFocus` is fired without `await` and spawns `ps` before it writes, so
  two quick presses can complete out of order and the *earlier* one would land
  last; the counter is taken before the first `await`, so the file only ever
  holds the newest press and the extension needs no ordering logic of its own.
  Best-effort throughout, like `vscode-state.mjs` — every failure degrades to
  today's behaviour, the window raised and the terminal untouched.
  **Self-routing stops being enough once a host is in play.** A pid is unique
  per machine and nothing else in the request is, so a remote chain full of
  ordinary numbers would match a local terminal by coincidence and reveal a
  stranger's. The request therefore carries `host` and a window acts only on its
  own; `null` is the local value on both sides, compared rather than assumed, so
  a request written before the field existed still reads as local — which is
  what it was. A **remote** session's chain is not walked here at all: it is
  computed during the poll from the `ps` table the fetch already collects, and
  travels on the session. A press is a synchronous key handler and may not wait
  on ssh, and walking the local table for a remote pid is worse than walking
  nothing, because it finds unrelated local processes rather than none.
- `src/window-state.mjs` — the reverse of `terminal-focus.mjs`: the daemon asks
  for a terminal there and learns what actually happened here.
  **`staleWindows` names the windows still to reload**, rather than leaving
  "4 of 5 windows have the extension" to send you round five of them. It is the
  same comparison kept as a difference instead of collapsed to two integers.
  **The join can only be on folders**: every IDE lock on this machine reports
  the same `pid` — VS Code's *main* process, shared by every window — and a
  lock's filename is its websocket port, so there is no per-window identity on
  that side to match the extension-host pid this file is otherwise keyed by.
  Windows are compared by their folder list, sorted and joined, so a multi-root
  window is one key rather than several (keyed by one folder it would look
  half-covered forever). That leaves exactly one thing it cannot resolve and it
  reports rather than guesses: two windows on the *same* folder are
  indistinguishable here, so the answer is `1 of 2 windows`, not a pointer at
  one of them — the same duplicate-folder ambiguity `focusWindow` has never
  solved, live on this machine with two locks on `kob/kob-backend`. Remote
  windows are excluded from both sides: their lock is on the other host so it
  is never in `ide/`, their published state is the only reason they are counted
  at all, and comparing only `host === null` states is what stops a remote path
  coincidentally covering a local one. Reads
  `~/.claude/streamdeck-windows/<extension host pid>.json`, one per open VS Code
  window, carrying that window's folders, whether it's focused, and which
  session's terminal is in front. **Synchronous on purpose** — its only caller
  is `deck.on("down")`, a synchronous handler, so an async read would resolve
  after the press was already decided. **The filename is the liveness handle**:
  named for the extension host's own pid, a window that has gone away is
  detected exactly with `isAlive` rather than guessed from a timestamp, which
  is what lets the extension write only on change instead of heartbeating a
  file every 400ms in every open window forever.
- `src/publish-sessions.mjs` — the daemon's second write, and the only one that
  isn't a key press: `~/.claude/streamdeck-sessions.json`, the live session list
  (id, cwd, folder, host, title) for the extension's "restore my sessions"
  command to remember while the window is still open. **Claude Code removes its
  own registry entry on exit**, so after VS Code has been quit there is nothing
  left on disk saying what was running — measured on this machine, every entry
  in `~/.claude/sessions` belongs to a live process and there are no corpses to
  read. The snapshot therefore has to be taken while the sessions are alive, and
  it has to come from here rather than the window reading `~/.claude/sessions`
  itself, for two reasons the extension cannot solve: a remote window's sessions
  live on the other machine and only `remote-fs.mjs` has fetched them, and
  attaching a session to a window is `matchFolder` plus the IDE locks — a join
  `getLiveSessions()` has already done by the time anything is drawn. Nested
  sessions are excluded: an Agent-tool subagent has no session of its own to
  resume and an SDK one was started by a script, so restoring either restores
  something nobody opened. Published through `liveSessions()` in `index.mjs`,
  which wraps every `getLiveSessions` call site, so the file is written on every
  poll rather than only on the polls of whichever board happens to be up.
- `src/accents.mjs` — the daemon's third write and its only piece of memory:
  `~/.claude/streamdeck-accents.json`, a `folderKey -> #hex` map so a project
  wears the same accent after a restart. Two functions, both best-effort — an
  unreadable file is a first run, a failed write is a restart that forgets —
  and both take `root` as a default parameter, the shape `sessions.mjs` uses,
  so `slots-check` round-trips them through a tmp dir. The read is called from
  `run()`, never at module scope: importing `index.mjs` must not touch the real
  `~/.claude`, or every check inherits this machine's live palette. `readAccents`
  drops non-string values rather than trusting the file — a half-written or
  hand-edited one would otherwise put whatever it holds straight into an SVG
  fill attribute. See the read-only invariant below for why the map it seeds is
  not what `claimAccent` treats as taken.
  **The file holds a record per project, not a colour**: `{"<key>": {"accent":
  "#4fc3f7", "order": 3}}`. A **string** value is the shape from before the
  page could reorder and is still read as that project's accent — the
  alternative was silently dropping every colour already on disk. Positions are
  sorted rather than trusted on read: they are only ever `projectOrder`'s own
  indices, but nothing stops a hand-edited file holding ties or gaps, and the
  array is what the board reads. Order lives here rather than in a fourth file
  because it is one more thing remembered about a project, and the bar for a
  new file is a reader that can't get at this one.
  It also owns `ACCENTS` — moved here from `index.mjs` because
  `config-server.mjs` needs the palette and `index.mjs` needs `openConfig` from
  `config-server.mjs`, and one of those edges has to not exist. `index.mjs`
  re-exports it, so `colors-check` and `slots-check` import it from there
  unchanged.
  **`applyAccentChoice` is the config page's mutation, and it is pure and lives
  here for the same reason `persistAccents` lives in `index.mjs`**: that
  function writes the real `~/.claude` file with no root argument, so an
  exported mutator that persisted would clobber this machine's accents with
  fixture folders on every check run. It trades with a *live* owner and
  **deletes** a closed one — handing a colour to something that isn't on the
  board is invisible, and leaving the duplicate means the collision rule
  resolves that folder's return by `readdir` order, silently taking a
  deliberate choice back days later. Because of that delete, a manual pick can
  never create the duplicate `assignSlots` exists to resolve.
- `src/history.mjs` — where the time goes: an append-only log of every session
  state change, and the per-project totals read back out of it. The daemon has
  watched every session's state every 2s since it was written and persisted
  none of it — nothing else on this machine has that view (`stats.mjs`'
  all-time numbers are another tool's cache), so "which project ate an hour of
  waiting for me to approve things" was unanswerable from data passing through
  here thirty times a minute.
  **A fourth file** (`~/.claude/streamdeck-history.jsonl`) rather than another
  key in the accents record: an append log with its own retention and its own
  reader is exactly the bar the read-only invariant sets for adding one.
  `recordStates` writes **only on change**, so a session busy for an hour is
  one record rather than 1,800, and it emits a `gone` record when a session
  disappears — without that, the final state of every session that ever ran
  counts up to `now` forever. Nested sessions are skipped: a subagent's time
  already reaches its project through its parent's own state, and counting both
  double-counts every minute a parent spent waiting on one.
  `summarise` takes `now` as an argument rather than reading the clock, because
  the last record of a live session is an **open interval** that runs to now —
  the one place this would silently start lying (get it wrong and every current
  session contributes zero, which reads as "nothing happened today"), and the
  reason it has to be reproducible for a check. Intervals are clipped to the
  window, so a session busy since yesterday owes today only today's share, and
  everything is attributed **by folder**: session ids are ephemeral and the
  question is about projects. Trimming is a whole-file rewrite, so it runs at
  startup and then once per local day, off the day boundary the summary already
  computes.
  **`concurrency` answers the question durations cannot**: eight hours of busy
  is one session all day or eight at once, and those are different machines. It
  walks the same intervals with a 5-minute sampling clock and reports an hourly
  high-water mark. Two things in it are load-bearing. **`states` is the split at
  the busiest sample, not a peak per state** — per-state maxima happen at
  different minutes, so they sum to more than the hour ever held and a stacked
  bar drawn from them runs off the end of its own track; the cost is that a
  session blocked at a quieter minute isn't in that chart, which is what the
  table's blocked column is for. And **unobserved time is reported as
  unobserved**: a change-only log cannot tell a sleeping machine from a quiet
  one, because five idle sessions overnight produce exactly as many records as a
  daemon that isn't running, which is none. That is what `TICK` is for —
  `recordTick` writes one line every `TICK_MS` (5 min) saying the daemon was
  watching, `OUTAGE_MS` is three of those, and a sample inside a longer gap is
  dropped rather than counted. Without it this machine's own log drew a ten-hour
  sleep as six sessions working all night, which is the shape the bug takes.
  Ticks carry `kind` and no `id`; every reader that walks records skips them,
  and `summarise` is the one that would otherwise grow a phantom project.
- `src/tokens.mjs` — what the tokens went on: hourly totals lifted out of
  Claude Code's transcripts, into a log that outlives them. Every assistant
  message carries `message.usage` beside an ISO timestamp, so the history is
  already on disk — for 30 days, and then it is gone (see the read-only
  invariant below). **Incremental by byte offset, never by mtime**: a transcript
  is appended to for hours, so "changed since last time" is true of a 1.2MB file
  that grew by one line, and re-reading it whole doubles every total in it. A
  partial trailing line is left for next time — this reads a file another
  process is writing, so the last line is routinely half-written, and the cursor
  advances only over bytes that ended in a newline. A file that has *shrunk* is
  a different file under the same name and is re-read from zero. Records are
  hourly buckets keyed by `(hour, cwd, model, sub)` rather than one per message:
  19,580 messages a day is 3,400 buckets, and the split that matters is the one
  the deck can't show — **38% of all calls on this machine came from Agent-tool
  subagents**, which is what `sub` (the transcript sitting under `subagents/`)
  records. What is kept from `usage` is chosen for what is *not recoverable
  later*: the 5m/1h cache-creation split, because those are billed differently,
  and `model`, for the same reason. An all-zero usage object — a `<synthetic>`
  message, an API error, an interrupt — earns no bucket; it was a third of the
  rows on the first backfill. `compactTokens` is not housekeeping: a pass
  appends a bucket for the hour in progress, so a 5-minute cadence writes a
  dozen rows for one hour, and merging them is what keeps the log growing with
  *time* rather than with the poll rate. The first pass reads the whole tree —
  11s against 2GB, measured — so `index.mjs` fires it without awaiting and
  guards it in-flight, the shape `remote-hosts.mjs` uses and for the same
  reason: the bookmark is written when a pass *finishes*.
  **It reads a second vendor's log, and that is what `provider` is for.** The
  ship-review skill drives `codex exec` for a second opinion, so part of the
  cost of a review lands in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
  nothing above could see it. Same file, same buckets, told apart by
  `provider`; a record written before the field existed is Claude's, which is
  why it defaults rather than being required. **`last_token_usage`, never
  `total_token_usage`** — Codex emits both on every turn and the total is
  *cumulative for the session*, so summing it counts every turn once per turn
  that follows: on this machine that inflated all-time output from 6.8M to
  79.6M, a factor of twelve, and nothing about the number would have looked
  wrong. The per-turn field sums to exactly the final total, verified against
  the longest session on disk. `cwd` and `model` live in the session header and
  in `turn_context`, which a byte cursor has usually already passed, so the
  head of the file is re-read for them rather than carried in the bookmark; and
  bookmarks are namespaced `codex/…` because both trees are keyed by a relative
  path into one map. Codex reports no cache-write counter and no ttl split, so
  those stay zero — absent, not zero-because-nothing-was-written.
  **What is still not captured is Claude billed to the API rather than the
  subscription.** Nothing in a transcript says which: no `costUSD`, no
  `apiKeySource`, and `service_tier` is `"standard"` on all of it. When that
  becomes findable it is another `provider` value, not another column — which
  is the whole reason the split is keyed that way rather than by a boolean.
- `src/config-server.mjs` — the config page: a local web UI, served by the
  daemon on loopback and opened from the stats board's config key, for setting
  which accent each live project wears, and — on its second tab, **Activity** —
  for the charts nothing on a 72px key could carry: output tokens per hour, the
  same split by model, sessions in parallel per hour coloured by state, and
  the per-project time table that tab used to be. The charts are **divs whose
  width or height is a percentage, rendered on the server** like everything else
  here; there is no canvas and no chart library, because `SCRIPT` is already
  the one part of this project no check can reach and a drawing routine in
  there would be worse. The two time series are **columns** — time on the x
  axis, one per hour — while the by-model list stays a row per name, because
  those are categories rather than a clock. A column carries its value in a
  `title` (25 numbers will not fit under 25 columns, and a tooltip needs no
  script) and only every third hour is labelled, anchored on the newest hour so
  the rightmost column is always named and the labels don't shuffle as the
  window slides. **The table follows the same window**, so the page has one
  time control rather than a picker over the charts and a fixed today/week pair
  under them — and it is sorted by the pie's own metric rather than by blocked
  time as it was before the pie existed, because a slice and its row have to be
  findable from each other and that only works in slice order. The blocked
  column keeps its colour, which is what drew the eye to it in the first place.
  The pie is a **`conic-gradient` on one div, not an SVG**: the slices are
  already percentages by the time they reach the page, so there is no trig and
  no path to build, and `index.mjs` hands over *cumulative* stops so even the
  running total stays out of the renderer. Slices wear the project's deck
  accent and each row carries the same colour as a dot, so the pie needs no
  legend; `folderAccent` survives restarts, so a project closed since still
  shows in the colour you remember it by. **An accent reaches a CSS colour slot,
  which is the boundary `pct` crosses** — `esc()` makes a string safe as text
  and a colour is not text, and `readAccents` only checks that the stored value
  is a *string*, so anything that isn't a plain hex becomes the neutral.
  Idle time is deliberately not in the table or the pie: a session sitting open
  is not time that went anywhere. Anything under a minute is dropped rather
  than drawn, because a minute is the floor `dur` can render and below it a row
  is four em dashes beside a slice too thin to see.
  **`PERIODS` in `index.mjs` is the whole window feature** —
  24h/7d/30d/all-time, each with the bucket it groups into, chosen to keep the
  column count in the 24–52 band (fewer and a bar chart is a table; more and
  the columns are thinner than the gaps). Every step is a whole number of
  hours because the stored records *are* hourly, so changing window is a
  regrouping rather than a re-read — that is why a year of history costs the
  same page load as a day. The window arrives as `?p=`, and the page renders
  whichever one `activity()` says it *used* rather than the one that was
  asked for, so an edited URL cannot produce a picker that disagrees with the
  charts under it. Coarse buckets sample concurrency proportionally coarser
  (`samplesFor`): a month of 5-minute samples against every interval in it is
  tens of millions of comparisons for a chart whose bars are a day wide, and
  the spike that costs is shorter than the resolution a day-wide bar was
  claiming anyway. Bars scale against the busiest column rather than a fixed
  ceiling — these series span three orders of magnitude between a quiet hour
  and a fan-out — and `pct` is the one number rather than string that reaches
  an attribute, so it is coerced rather than trusted, the same rule the folder
  field lives by. **Server-rendered HTML with form POSTs,
  not a JSON API**, and the deciding reason is this repo's quality model rather
  than taste: a POST handler is checkable by a real server on port 0 and a real
  `fetch`, while client JS inside a template literal is the one thing here that
  nothing can lint, import or run. Its whole coupling to the daemon is a `deps`
  object of `projects()` and `setAccent()`, so when drag-to-reorder needs real
  interactivity the page renderer is rewritten without touching `index.mjs` —
  and colour picking moves onto that same flow in the same pass, so the page
  never runs two paradigms at once.
  The trust boundary is not simplified: loopback bind, a per-server
  `randomUUID` checked **before** routing (so an unknown path without a token
  answers 403 rather than confirming the path is unknown), both fields
  validated against closed sets — the palette by exact string match, not
  "looks like hex", because `colors-check`'s floors cover those eight values
  and nothing else — a 4KB body cap, and `Referrer-Policy: no-referrer` on
  every response because the token is in the URL.
  **`esc()` is the full five-entity escape, not tags only.** The hidden
  `folder` field is *attribute* context, where a `"` breaks out with no `<`
  involved, and a folder key is another machine's string for a remote project
  — the same untrusted-input class as `isPathSafeId`. `config-check` covers
  that case specifically, because a tag-only escaper passes both `<script>`
  assertions and still fails it.
  Over the body cap the reader discards and drains rather than calling
  `req.destroy()`: a killed socket reaches the browser as a network error
  rather than as the refusal it is. That cost a debugging round the first time.
  **`SCRIPT` is the one piece of this project no check can reach** — no lint,
  no import, no `scripts/*-check.mjs` can execute it. That was the known price
  of drag-to-reorder, and it is why everything decidable on the server is
  decided there: the client computes which row the pointer is over and which
  side of its midpoint, and nothing else. Both mutations POST and then render
  whatever comes back — `fetch` follows the 303 itself, so the response body
  *is* the re-rendered page. One renderer, on the server, for both
  interactions, which is what stops a drag and a colour pick behaving
  differently. Every listener is delegated from `document`, because a mutation
  replaces `document.body` wholesale; bind to a row and the page stops
  responding after the first change. The form stays a real form, so with JS off
  colour picking still works as it did before drag existed.
  Verified by driving it in a real browser, since nothing else can: two drags
  and a swatch click, each after a body swap, produced the right `reorder` and
  `setAccent` calls.
  **`POST /order` takes what the pointer was over, not where the row should
  go** — `target` plus `side` (`above`/`below`), never a computed anchor. That
  split was learned the hard way: the arithmetic started in the browser, where
  `drop` read the side off a class `clear()` had already removed, so *every*
  drop resolved as "above". Every side/target pair but one still produces a
  plausible anchor, so the only visible symptom was that dropping below the
  last row landed a project second-to-last — and nothing could see it, because
  the code was in the one place no check reaches. Moved to the server it is
  four lines under `config-check`, including the null-anchor case that was
  wrong. **The rule this is an instance of: if a piece of the client is doing
  arithmetic rather than reporting what the pointer did, it is in the wrong
  file.**
  `target` is validated as well as `folder`, for a sharper reason than
  `folder`: `moveProject` reads a key it can't find as "put it last", so a
  stale one would quietly drop a project to the bottom rather than erroring,
  and you would blame the drag. Dropping a row on itself is a no-op rather
  than a 400 — the client won't send it, but the arithmetic must not depend on
  that.
  Dragging into the empty space **below** the list marks the last row, because
  that is the natural way to ask for "last" and doing nothing there made the
  one gesture people reach for feel broken.
- `src/sdd-ledger.mjs` — tasks Claude Code doesn't know about. The progress
  bar and the detail board both come from `~/.claude/tasks/<session id>/`,
  which is filled only when a session uses Claude Code's *own* task tool — a
  session driving superpowers' subagent-driven development instead keeps six
  tasks in a ledger inside the project, dispatches an implementer subagent per
  task, and narrates the rest. Measured: that session showed a blank progress
  bar and an empty detail board through a day of work, and every
  `~/.claude/tasks/<id>/` on this machine holds nothing but a `.lock` and a
  `.highwatermark`. **This is the first thing the daemon reads outside
  `~/.claude` and VS Code's storage** — the read-only invariant is about the
  four files it *writes*, none of which are here, but it is a new direction and
  gets its own file for that reason. It returns the *same shape*
  `~/.claude/tasks` produces (`{subject, status}`), so `taskCounter`,
  `taskWindow`, the bar and the detail tiles all work on it unchanged and there
  is one task list in this project rather than two.
  **It parses another tool's file, and only the two parts that tool depends on
  itself**: `scripts/sdd-workspace` fixes the directory at
  `<repo root>/.superpowers/sdd/<plan basename>/`, and SKILL.md's own recovery
  rule is "tasks with a `Task <N>: complete` line are DONE — resume at the
  first task without one". A controller that misreads either re-runs finished
  work, so they are as stable as another tool's format gets; the prose and the
  fix-round lines between them are deliberately not read. Titles come from the
  `task-<N>-brief.md` filenames, so a cleaned-up workspace still counts and
  just reads "Task 3". Two guards earn their place: the `# SDD ledger` identity
  line the skill mandates, without which this is somebody else's progress.md,
  and a 24h mtime cap — a finished plan deletes its own workspace, so an
  abandoned one would otherwise show "3 of 6" on a key forever.
  **The fallback lives in `readTaskList`**, the one function the bar and the
  detail board already both route through, so neither can have it without the
  other; Claude Code's own tasks win whenever there are any. It is the one
  reader that is **local-only** — `readLedgerTasks(cwd)` needs a path on *this*
  machine and `remote-fs.mjs` fetches `~/.claude` and nothing else, so both
  call sites pass null for a remote session rather than reading a stranger's
  directory.
- `src/statusline.mjs` — the context gauge's one install step, as a pure
  decision: the block, the whole minimal script, `insertBlock` and `decide`.
  Nothing here writes; the two things that do are commands
  (`scripts/statusline-prompt.mjs` for this machine, `scripts/remote-install.mjs`
  for a host), which is what keeps `statusline-check` able to run it. See the
  status-line invariant below for what the five answers mean and why `manual`
  is one of them.
- `extension/` — the other half, plain CommonJS with no build step and no
  dependencies, installed by copying it into `~/.vscode/extensions` (a line
  count isn't pinned here for the same reason it isn't for `src/`: it goes
  stale the moment either side grows). Polls the request file every 400ms and
  calls `terminal.show()`, which activates the terminal's tab group — that is
  what brings a joined split forward with the right pane active.
  `extensionKind: ["ui"]` is required, not cosmetic: in a remote window the
  extension host runs remotely, where the request file is another machine's
  and the terminal pids are remote pids.
  **`extension/routing.js` exists so the routing can be checked at all.**
  `extension.js` opens with `require("vscode")`, so nothing in it can be loaded
  outside a running editor — which made this the one piece of the project whose
  bugs surfaced only by reloading a window and watching, and every mistake its
  routing made was found by reading rather than running. `routing.js` requires
  nothing and takes `folders` and `remoteName` as arguments, so
  `extension-check` exercises the real decision path instead of a copy of it.
  Writing that check immediately found a request with no `ts` being accepted
  forever: `now - undefined` is `NaN`, and every comparison against `NaN` is
  false, so the staleness guard read it as fresh. Keep new routing decisions in
  that file rather than inline here, for the same reason. `extension/restore.js`
  is the same split for the restore command, and the part of it worth checking
  is the same part: whose sessions these are. It refuses a session id that
  isn't a UUID — twice, once when filtering the published list and again in
  `resumeCommand` — because that id reaches a shell as `claude --resume <id>`
  and, for a remote window, was chosen by the other machine.
  **Restoring is what was remembered minus what is running**, so an ordinary
  window reload (whose terminals survive) correctly offers nothing, and a second
  run of the command doesn't open a second copy of everything the first one
  restored. The remembering itself is `context.workspaceState`, VS Code's own
  per-workspace storage: scoped to this window by the platform, survives a
  restart, and unlike `streamdeck-windows/` leaves no file for anyone to reap.
  **An empty list is never written over a non-empty one** — quitting VS Code
  kills the terminals before it deactivates extensions, so a snapshot taken then
  would honestly record nothing running and erase the only copy of what to
  restore. `deactivate()` deliberately does *not* take a final snapshot for that
  reason; the last timer tick before the quit is the one that matters. It also does the two things
  `window-state.mjs` reads: publishes this window's folders/focus/active-terminal
  to `~/.claude/streamdeck-windows/<pid>.json` on every tick (and immediately
  after a reveal, so a fast second press doesn't read a stale one), and sweeps
  dead windows' orphaned files at `activate()` (`reapDeadWindows`) — a crashed
  window never runs `deactivate()`, and once its pid is recycled the daemon's
  liveness check would otherwise trust a frozen state file weeks after that
  window died. **Its version tracks the daemon's and `terminal-focus-check` enforces that** —
  a release bumps `package.json` and `extension/package.json` together. The
  number is not bookkeeping: it is the only way to tell a window running the
  current extension from one still running whatever it loaded at startup, which
  no amount of reinstalling changes until the window reloads. VS Code reports it
  (`code --list-extensions --show-versions`, the Extensions view, and
  `Developer: Show Running Extensions`) and the stats board already shows the
  daemon's, so the two agreeing is the entire "does this window need a reload?"
  check, done by eye. Let them drift and that comparison quietly starts lying.

### Invariants worth knowing before changing things

- **Ordering is first-seen, never activity.** `sessionOrder` in `index.mjs` is
  an append-only map for the daemon's lifetime, and `projectOrder` is an
  append-only array. Folders are deliberately kept after their last session
  ends so a returning project reclaims its slot and accent colour. Anything
  that re-sorts a settled board breaks the point of the tool: muscle memory for
  where a button is.
  **A project's position is an array index, not a counter.** It was
  `folderOrder.set(key, folderOrder.size)` at first sight, which cannot express
  "third, because you dragged it there"; `folderOrder` is now a derived index
  rebuilt from `projectOrder` by `reindexProjects()` whenever the array moves.
  An array also makes both invalid states unrepresentable — no project holds
  two positions and no position holds two projects — which a Map of integers
  did not.
  **Dragging in the config page is the second exception, and it is the
  opposite of the first.** The attention queue re-sorts because it is transient
  triage you read and leave. A manual order is you *setting* the muscle memory
  this rule protects, so it outranks first-seen rather than violating it: a
  project nobody has dragged still lands on the end, exactly as the counter
  did. `moveProject` is pure and in `accents.mjs` for the same reason
  `applyAccentChoice` is — the persisting caller writes the real `~/.claude`
  file, so a check that drove it would clobber this machine's order with
  fixture folders. Its splice removes before it locates the anchor, so
  dragging a row down past itself lands where you dropped it rather than one
  short; that is the whole reason it is a function with a check rather than
  two lines inline.
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
  **A folder's identity is `host:folder` for a remote session, and the bare
  path for a local one** (`folderKeyFor`). Two hosts can hold the same path —
  `/home/pi/x` on two Raspberry Pis is a live case on this machine — and
  everything that groups a project keys on the folder: block ordering, accent
  colour, the "is this the first key of a block" test. Unqualified, those two
  projects merge into one block wearing one colour, which nothing on the deck
  would explain. The same qualification has to reach `nestedFor`'s fallback
  branch too: an SDK session carries no `parent` to attach its marker to and
  matches by folder instead, so without the host in that key one host's
  subagent draws its marker on the other host's key and feeds `mostUrgent` for
  a project it has nothing to do with — a session id would have been
  host-scoped by construction, but a bare folder isn't. A local session's key
  is still the bare folder, so a machine with no remote hosts sees no change,
  accent included.
  **Remote sessions take a slot in first-seen order like everything else, no
  tier, no cap, no precedence over local sessions** — the 13-slot overflow
  this makes more likely already has an answer one layer up: `attentionQueue`
  is passed the whole session list, not the visible one, so a slotless
  session that wants you still pulses the attention key and gets a tile on
  the attention board, whether the session that has nowhere to say so is
  local or remote. There is no conceptual difference between the two, so any
  ordering that favoured one would be arbitrary.
  **Three time comparisons now cross a machine boundary.** A remote session's
  `ts` (the registry's `statusUpdatedAt`, read off the fetched tree) feeds a
  key's displayed age and `attentionQueue`'s longest-stuck ordering; tar's
  preserved mtimes feed `SUBAGENT_IDLE_MAX_S`. All three compare a remote
  clock's timestamp against `Date.now()` on this machine. NTP makes this a
  non-event in the common case, but a Raspberry Pi has no RTC, so the real
  window is a boot before it's synced: a clock behind local retires that
  host's subagents instantly and sorts it to the head of the attention queue;
  a clock ahead makes ages go negative. Nothing here corrects for it.
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
- **Read-only, two install steps.** No hooks, no `settings.json` writes, no
  config file. The daemon reads from `~/.claude/`, VS Code's storage and the
  usage endpoint, and writes four files into it. Two are messages to the
  extension: `~/.claude/streamdeck-focus.json`, the terminal-focus request, and
  `~/.claude/streamdeck-sessions.json`, the live session list the extension's
  restore command remembers (`publish-sessions.mjs`). Both are the same shape of
  thing — one file, rewritten in place, no reader addressing, every window reads
  it and keeps what is its own — and both are best-effort in the same way: a
  window that finds neither behaves as it did before either existed. It was one
  file until the restore command needed the daemon's remote reach, which is the
  bar for a third.
  **The third is the daemon's own memory, read by nothing but the next run of
  the daemon**: `~/.claude/streamdeck-accents.json` (`accents.mjs`), which
  folder wore which accent. `folderOrder` rebuilds first-seen on every start, so
  a project reclaims its slot after a restart — but its *colour* was re-picked
  from scratch in `readdir` order, so half the board's identity survived a
  restart and half didn't. It is still not a config file: nothing in it is
  meant to be hand-edited, and a value nobody typed can always be thrown away,
  which is why every failure path reads as a first run.
  **What is remembered is not what is enforced.** `claimAccent`'s `taken` set
  is *live* folders only, never the file — with eight accents, honouring every
  remembered colour would leave every ninth project ever seen on the modulo
  fallback, and twenty projects sharing eight accents works precisely because
  only the ones on the board at once have to differ. The cost is a case that
  could not happen before: two folders that were never live together can each
  have remembered the same colour, and `assignSlots` resolves that the moment
  they meet — first one processed keeps it, the later one re-claims and the
  re-claim is written back, so the loser settles rather than flipping every
  poll.
  **The daemon also listens, but only after you ask it to.** Pressing the
  stats board's config key starts a loopback HTTP server (`config-server.mjs`)
  that lives for the daemon's remaining life — the one thing here that accepts
  a connection rather than reading a file. It writes nothing new of its own:
  the page's mutations go through `applyAccentChoice`/`moveProject` and
  `persistAccents`, into the accents file that already existed. The port does
  not exist until the press, which is why there is no off switch for it the
  way `STREAMDECK_NO_REMOTE=1` is one for ssh.
  **The fourth file is the first the daemon appends to on its own schedule**:
  `~/.claude/streamdeck-history.jsonl` (`history.mjs`), written whenever a
  session changes state rather than when you do something. Everything above it
  is rewritten in place and says what is true now; this one accumulates and
  says what was true, which is why it is the only one with a retention policy.
  **The fifth file is the first whose source is outside this project's view
  entirely**: `~/.claude/streamdeck-tokens.jsonl` (`tokens.mjs`), hourly token
  totals lifted out of Claude Code's transcripts. It exists because those
  transcripts are **deleted** — `cleanupPeriodDays` defaults to 30 and is doing
  it, measured: the oldest transcript on this machine was exactly 32 days old.
  So a page that reads them live can never answer anything about last quarter
  no matter how it is cached, and copying the numbers out is the only way to
  keep them. Retention here is a year rather than a month, because outliving
  the source is the entire point. Its sixth file is a **bookmark, not data**:
  `streamdeck-tokens.pos`, which byte of each transcript has already been
  counted. It cannot live in the log — a bookmark is rewritten every pass and
  the log is only appended to — and without it every pass re-reads 2GB and
  doubles every total. It is written *after* the log, never before: a crash
  between the two re-counts a few lines, where the other order drops them for
  good. Over-counting is visible and fixable; a hole is neither.
  There is another file in this feature and the daemon does **not** write it:
  `~/.claude/streamdeck-windows/<pid>.json` is published by the extension and
  only read here. Keep it that way — a daemon that deletes files it did not
  write is a worse trade than leaving that sweep to the extension, which
  already does it (`reapDeadWindows()`, on every `activate()`): a crashed
  window's file would otherwise sit until its pid is recycled onto an
  unrelated process, at which point the liveness check starts trusting a
  frozen `focused`/`activeSessionId` from a window that died weeks ago.
  An earlier hook-based version was deleted; don't reintroduce one.
  A remote host bends "only files in `~/.claude`" further than that: a fetch
  extracts into a scratch tree at a literal `/tmp/streamdeck-remote-<pid>` —
  **not** `os.tmpdir()`. That path also anchors `fetchSource`'s
  `ControlPath` socket (that path, plus `cm-<host>`, plus ssh's own random
  suffix while the bind is in flight), which is length-checked against the
  ~104-byte Unix domain socket limit; `os.tmpdir()` on macOS is a long
  per-user path under `/var/folders` that landed exactly on that limit, so
  every fetch failed silently as an ordinary "host unreachable", with nothing
  to point at the socket path as the cause. `/tmp` is a short, stable symlink
  on macOS, and this daemon is macOS-only already. The trade this makes and
  gives up is worth recording, not just implying: `os.tmpdir()` on macOS is
  `0700`, private to the user who created it, while `/tmp` itself is
  world-writable, so a scratch directory created ahead of time under `/tmp` is
  a symlink-through target for `tar -x` — a name any local user could
  pre-create before the daemon ever runs. That stands only under this
  project's single-user macOS model; a shared machine would need the private
  directory back. Each fetch swaps that tree
  into place by rename rather than letting `tar -xf` merge it — see
  `remote-fs.mjs` above — for the same reason the daemon never merges anything
  else it's handed: a merged tree keeps what the remote host deleted.
- **One install step, in the status line, and `npm start` now offers it.**
  Context usage is the exception to the above: Claude Code hands a session's
  context percentage to the status line and nowhere else, so
  `~/.claude/statusline-command.sh` writes it to
  `~/.claude/ctx/<session id>.json` for the daemon to read. That block is
  quoted in `README.md`. If a machine has no status line, or the block is
  dropped, the gauge simply doesn't draw — never make a missing file an error.
  Don't be tempted by the transcript's `usage` totals instead: the percentage
  needs the model's window size (1M on some, 200k on others), which the
  transcript doesn't record.
  **It was the one part of setup that could only be done by hand**, and its
  failure mode is silence: no ctx file looks exactly like a healthy machine
  mid-first-turn. `scripts/statusline-prompt.mjs` is the second `prestart`,
  beside `ext-prompt.mjs` and with the same contract — silent when there is
  nothing to do, one line when there is nobody to ask, every path exits 0.
  **The decision is pure and lives in `src/statusline.mjs`** (`decide`,
  `insertBlock`, `CTX_BLOCK`, `MINIMAL`) for the reason `applyAccentChoice`
  does: the script around it writes the real `~/.claude`, so a check that drove
  *that* would edit whatever status line this machine happens to have.
  `statusline-check` drives the pure half against fixtures and then runs
  `MINIMAL` under a real `bash` — it is shell, and a template literal that
  looks like shell is not the same as one that parses.
  Its five answers are the whole feature: `ok` (silent), `nojq`, `install`
  (the only one that touches `settings.json`), `append`, `manual`. **`manual`
  is not a failure path**, it is the refusal `remote:install` already makes —
  a status line is read on every turn, and a `statusLine` key pointing at
  something else, or a script that reads stdin some other way, is described
  rather than guessed at. The block goes *after* `input=$(cat)` rather than
  appended, because it reads `$input` and a script ending in an `exit` would
  swallow it silently; `insertBlock` returning null **is** the test for
  "appendable", so `decide` calls it rather than matching the anchor twice.
  `MINIMAL` is shared with `remote-install.mjs` rather than copied — two
  versions of a shell block is two things to keep in step, and only one of them
  would ever be the one that was tested.
  **A remote host needs the same step, and `npm run remote:install -- <host>` is
  the only thing here that writes to another machine.** It is a command you run,
  never `postinstall` — `npm install` reaching across ssh to edit a config is
  not a trade this project makes — and it refuses rather than overwrites: a host
  with an existing status line, or an existing `statusLine` key, is left alone
  and told what to add by hand. A status line is read on every turn, and
  replacing one to feed a gauge on a key is not a fair trade.
  **"Exists" there means `-s`, not `-e`** — a zero-byte file is a placeholder, a
  truncated write or a `touch`, not something anyone wrote, and refusing to
  install over it protects nothing while blocking the only command that fixes
  it. That is not hypothetical: an empty executable appeared on a host that had
  none, with no `statusLine` key even referencing it, and the install refused
  itself out of a file with nothing in it. The probe takes its directory from
  `$CLAUDE_DIR` so `remote-install-check` can run it under a real shell against
  fixtures — the decision is shell semantics, and a check asserting the command
  *string* would have passed happily while `-e` was wrong.
  **The gauge's file is fetched through call 2's path list, not the tar.**
  `ctx/` accumulates one file per session a host has ever run and tar spends a
  512-byte header on each: measured, 118 files holding 1,775 bytes of content
  tarred to 360KB, against a whole tree of 20KB. Asking for exactly the live
  sessions' files costs a few hundred bytes and no extra round trip. Filtering
  the tar by mtime was the alternative and is worse — a session can sit idle for
  days with a perfectly good context file, which is precisely what "a stale file
  is fine" above means.
  **A remote session id is not this machine's data, and it reaches a path.**
  It comes out of the other host's registry, so a compromised — or simply
  hostile — box chooses it, and opening a Remote-SSH window is not a statement
  of trust in that box's filesystem. `join(root, "ctx", id + ".json")` collapses
  `../`, so an id like `../../../../tmp/x` escapes the scratch tree and the
  bytes written there come from the same host: an arbitrary file write, on this
  machine. The same string also goes over stdin as a path the host reads, so
  traversal there reads a file outside `~/.claude` and streams it back.
  `isPathSafeId` refuses rather than sanitises — a real session id is a UUID, so
  a slash or a `..` in one has no legitimate reading, and rewriting an
  attacker's string into a "safe" one is how the next bug gets built. Everything
  else derived from remote data was already safe: `projectDirFor` flattens a cwd
  through `[^a-zA-Z0-9] -> -`, and tar refuses absolute and `..` members. This
  was the first place remote data reached a path that gets *written*, which is
  the thing to watch for when adding the next one.
- **The extension rides on `npm install`; the window reload is the step that
  can't.** `postinstall` runs `ext:install`, which copies `extension/` into
  `~/.vscode/extensions` — so a fresh clone or a `npm install` after a pull has
  the current extension without anyone remembering to ask for it. `prestart`
  (`scripts/ext-prompt.mjs`) catches what postinstall misses — an install that
  predates the extension, a copy deleted since, or a copy another worktree
  installed — by comparing `extension/package.json`'s version against the
  installed copy's and offering to fix it, defaulting to yes, at the one moment
  someone is definitely watching. Drift is *named* (`installed is v1.1.19, this
  checkout is v1.1.22`) rather than silently corrected: with one extensions
  slot shared by every worktree, which version is in there is the fact worth
  seeing. This catches a stale copy on disk, never a stale *running* window —
  that still needs the reload below, and the extension publishes no version for
  the daemon to check. It
  never fails the daemon it precedes: no VS Code on the machine, no TTY to ask
  in, or EOF at the prompt all print a line and exit 0. What that
  cannot do is reload the editor: windows already open when it lands keep
  running the *old* code until `Developer: Reload Window`. That is why the
  install ends by saying so. An automatic upgrade nobody
  notices is worse than a manual one they do — the copy is silent, the
  mismatch is silent, and the only symptom is a fixed bug that appears not to
  be fixed.
  **But the question it asks is content, never the version**, and that
  distinction is the whole reason the prompt is worth reading. The two
  package.json versions move together on every release (below), while the
  extension itself changed in 9 commits out of 181 — so a stamp-only bump used
  to name a drift, ask to fix it, and tell you to reload every open window over
  code that was byte-identical. v1.1.29 is exactly that commit. `signature()`
  hashes what VS Code actually loads, with `version` stripped from the manifest
  (it tracks the *daemon*) and `.md` files left out (nothing loads them); equal
  signatures mean the slot is re-stamped **silently** and nobody is asked
  anything. A reload prompt that is usually noise is a reload prompt nobody
  reads, which costs exactly the reloads that matter.
  `ext:install` is that same script under `--yes` — one decision, one copy, and
  the reload line only where it is earned — which is also what keeps
  `postinstall` from printing it on every `npm install`. `--yes` skips the
  is-VS-Code-here gate, because `npm install` has always installed the slot
  unconditionally and failing over a missing `~/.vscode` is the one outcome to
  avoid there. The `mkdir -p` in that script is not decoration either: without it,
  a machine that has never run VS Code fails `npm install` outright over a
  missing directory.
  **A worktree's `npm install` overwrites the installed extension with that
  worktree's copy**, which is worth knowing in a repo where most work happens
  in worktrees — an experimental branch silently becomes the extension every
  window is running. There is only one `~/.vscode/extensions` slot and no
  version in its name, so this is inherent rather than fixable here; if it
  bites, run `npm install` from the main checkout to put it back.
  Terminals survive that reload (`terminal.integrated.enablePersistentSessions`
  defaults on, and ptyHost is a separate process holding the `claude` processes
  up), but prove it on a scratch window before doing it to one with real work in
  it. A window without the extension simply doesn't reveal terminals — never
  make its absence an error, same rule as the status line's context file.
- **A guard that encodes "X is impossible" is deleted in the commit that makes
  X possible.** This has now gone wrong three times in one feature, always the
  same way and never by anyone deleting a guard: the guard stayed correct while
  its *precondition* quietly disappeared underneath it.
  `dueHosts`'s in-flight claim was written against concurrency the code did not
  yet have, and the change that made the fetch fire-and-forget introduced it.
  The eviction loop was safe only while `remoteSources` calls were serialised by
  the poll awaiting them, and the same change removed that.
  `isRepeatPress` short-circuited every remote press to the folder rule because
  a remote window could never report a terminal active — true until remote
  reveal shipped, after which it made a project's *second* remote session open
  the detail board instead of revealing its own terminal.
  All three read as correct in isolation, which is why per-task review found
  none of them; the first two were caught by a whole-branch pass and the third
  by remembering the pattern. When a comment says something cannot happen, it is
  a dependency on the rest of the system, not a local fact.
- **Terminal focus makes the duplicate-folder ambiguity worse, deliberately.**
  Two windows open on the same folder (live on this machine already —
  `11854.lock` and `53173.lock` both claim `kob/kob-backend`) route differently
  for the two halves of a press: the extension matches by pid and so reveals the
  terminal in the window that really owns the session, while `focusWindow` opens
  a file and macOS can raise the *other* one. You end up in the wrong window
  with the right window's panel changed behind you. Today's fix would be to aim
  the raise at a specific window, which is not possible from outside the editor
  (see `docs/roadmap-reveal-terminal.md`). Gating the reveal on "is this folder
  unambiguous" was rejected: it would disable the feature for the multi-root
  windows it helps most.
- **Window focus must not disturb the window.** The current route (open a file
  the window already has open) was chosen because `code -r`, `open -a Code
  <folder>` and `vscode://` all either replace a window's content or spawn an
  extra one, and AXRaise needs Accessibility permission. The reasoning is in the
  comment above `focusWindow()` — read it before proposing an alternative.
- **MK.2 hardcoded-ish**: 15 keys, 72×72, macOS only, exclusive HID (the Elgato
  app cannot run alongside). The **whole bottom-right run of three is
  reserved** — key 14 is the usage readout and the stats toggle, key 13 the
  attention key, key 12 the free-capacity key — leaving **12 session slots**.
  Extra sessions past that get no key, by design.
  **The third reserved key is what makes that "by design" honest.** With 14
  sessions on this machine the board stopped fitting, and the thing being
  scanned for turned out not to be alarms — 9 of 14 sessions were idle, 0
  blocked. A deck full of idle keys is being read as *capacity*: "that one is
  free, I can start the next piece of work there". So the two questions a press
  can answer are "who needs me" (`attentionQueue`) and "where can I put the
  next thing" (`freeQueue`), and both are now answered **completely**, from the
  whole session list rather than the visible one. What falls off the end of a
  full board is at-a-glance familiarity, never something you could have acted
  on — which is what lets the board stop having to fit rather than growing
  paging or collapsing projects into group keys.
  `freeQueue` folds nested state exactly as `refresh` does
  (`mostUrgent([own, ...nested])`), or a session whose Agent-tool subagent is
  still running would be offered as free while its own key two rows up reads
  busy. `shell` is likewise not free. Its own board truncates at 12 like every
  other, but ordered longest-idle first rather than by first-seen, so what
  survives truncation is the most obviously spare — a defensible cut, unlike
  the sessions board's arbitrary tail.
  The free key is **never coloured and never pulses**: green already means
  "working" everywhere here, so a green key for "not working" would fight the
  palette, and nothing on it is wrong. Dark with a big white number, like the
  usage key it sits beside. `drawFree` therefore caches no `renderParams` —
  that cache exists only so `pulse()` can redraw between polls.
  The slot it cost came out of the stats board, which used to fill all 13 and
  now fills all 12 exactly (two reset tiles, seven stats, the version, the back
  key, the config key). The **"Blocked today" tile went with it**, and that is
  the right thing to have lost: the Activity page now carries blocked time per
  project across four windows beside a pie, which is strictly more than one
  number could say.
- **A second press means "tell me more".** Tracked as a global "was the
  immediately preceding press" check (`lastPress` against `isRepeatPress`), not
  a timeout — only the press right before this one counts, so a key from
  another project always breaks the chain. First press focuses the window,
  second opens the pressed session's detail board. **The match is on the
  session, and on whether the press changed anything.** It used to be on the
  folder, justified by every key in a project's block doing the identical
  thing — moving along the block was the same gesture as pressing one key
  twice. **Terminal focus falsified that**: key A and key B now reveal two
  different terminals, so B is a new first press, not a repeat of A. The
  symptom was that a project's second session was unreachable — its key
  opened the detail board instead of its terminal, which is the one thing the
  extension exists to do.
  "Changed anything" is not knowable out here, so `readWindowStates` reads it
  from what the extension publishes: the window's focus and which session's
  terminal is in front. Inferring it instead ("you pressed this session last,
  so its terminal must still be showing") is one line and wrong in the two
  cases you would actually notice — after alt-tabbing away, and after clicking
  another terminal by hand.
  **A window that publishes nothing keeps the old folder rule**, so
  degradation is per window rather than per machine. Do not replace that with
  a check for whether the extension is *installed*: on 2026-08-16 it was
  installed and zero open windows were running it, because none had been
  reloaded since — the install check would have answered yes and been
  useless. A live state file proves the thing that matters, which is that
  *this* window is running it.
  `isRepeatPress` is exported and covered by `slots-check` because none of
  this is visible without a deck.
  Any press then leaves an overlay board, including the key that opened it —
  in the attention queue that press still focuses the window on the way out,
  which is the point of pressing one there; on the detail board its tiles have
  no window of their own, so they only dismiss. **Leaving a board clears the
  chain**, in `setView` and again for every press the detail board swallows.
  Without it, the press that dismisses detail (or a poll-loop exit, when the
  session ends underneath you) leaves its project sitting in `lastPress`, and
  the next press that `isRepeatPress` would call a repeat — the same session
  again, or any sibling key when the window publishes nothing — reopens the
  board you just left instead of focusing its window.
- **Nested means spawned by another session, not "in a subdirectory".**
  `sessions.mjs` sets `nested: true` from `entrypoint`: `sdk-py`/`sdk-ts` is an
  agent some script started, `cli` is one you started yourself.

  **An Agent-tool subagent isn't in the registry at all** — background or not,
  it runs inside its parent's process, so `entrypoint` never sees it and
  "Waiting for 1 background agent to finish" showed nothing on the deck. It
  exists on disk only as `projects/<slug>/<parent id>/subagents/agent-*.jsonl`
  with a sibling `.meta.json` (the Agent call's own `description`), and
  `readRunningSubagents` synthesises one nested pseudo-session per *running*
  one — no registry entry, so no `state` either: a running agent is busy by
  definition, and its parent's folder is its folder. Running is the newest
  `stop_reason` in that transcript, which is exact rather than a guess:
  "tool_use" is an agent waiting on a tool, "end_turn" is one that has handed
  its result back and will write nothing more. Two cases never write an
  ending — an agent spawned seconds ago and an agent interrupted mid-tool —
  and both are settled by mtime: no ending plus a fresh file is running,
  `SUBAGENT_IDLE_MAX_S` (10 min) quiet retires it. Don't reach for the parent
  transcript's `tool_result` instead: a backgrounded agent's result lands the
  moment it's *spawned*, so it says nothing about whether it's done.

  `assignSlots`
  keeps nested ones off the board's slots; they attach to a key as a small
  square coloured by their own state, and become readable tiles in two places —
  the attention queue if they block, and the detail board they attach to,
  pinned to its tail.

  **Which key is `nestedFor`, and it goes by parent, not folder.** An
  Agent-tool subagent carries the `parent` its synthesis in `sessions.mjs`
  recorded, so it lands on the key of the session that actually spawned it —
  and since `refresh` colours a key `mostUrgent([own, ...nested])`, that is the
  difference between a busy agent tinting its own key and tinting a *sibling's*.
  Folder-attachment shipped first and got this wrong: with three sessions open
  in one repo, the greened key was whichever came first in the block, which
  after a daemon restart is `readdir` order of `~/.claude/sessions` and means
  nothing — an idle session that had just finished sat green for an agent two
  keys over. An SDK session has no key of its own to point at and so carries no
  `parent`; it keeps the old behaviour, folding onto the block's first key,
  which is what the `primary` argument is for. `refreshDetail` calls the same
  helper so a tile and a marker can never disagree about whose agent it is.

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
- `docs/roadmap-reveal-terminal.md` — partly superseded: the extension it
  investigated is now built (`extension/`, `src/terminal-focus.mjs`), so its
  own "investigated, not built" header no longer holds for that part. Still
  worth reading for what it still holds: every non-extension alternative ruled
  out and why (`code` CLI, `vscode://` URIs, the IDE websocket, keystroke
  automation — don't re-investigate any of these), the window-raise-addressing
  problem neither this nor the extension solves (the source for the
  duplicate-folder invariant above), and a second, separately-still-not-built
  investigation into ordering the deck by terminal position.
