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
npm run subagents-check # which Agent-tool subagents are still running
npm run colors-check   # palette contrast + separation floors
npm run terminal-focus-check # pid-ancestry walk + newest-press-wins guard
npm run vscode-state-check   # which window's storage answers for a folder
npm run extension-check      # whose window a focus request is for
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
  somehow on" isn't representable. Its four kinds — `sessions`, `stats`,
  `attention`, `detail` — each have one branch in the poll loop and one
  `refresh*` function, and the same 13 session keys are redrawn by whichever is
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
  board, which draws only the 13 session keys. `detailLayout` lays out a
  two-key title, STATE/CONTEXT/MODEL stat tiles (CONTEXT passes `pie` to
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
  `gaugeColor` flashes red *brighter*, never dimmer: the gauge is 2px on a
  near-black track held to a contrast floor, and dropping below that floor for
  half of every cycle is a gauge that keeps vanishing. Phase 0 is exactly
  `usageColor`, so every board that doesn't pulse draws what it always did.
  **Two gradual versions shipped before this one and neither was visible on
  the deck** — a pink cosine over 14s, then a white one over 7s, both passing
  `colors-check`. 2px of line is too little to carry a gradient: most of a fade
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
  is why white body text, 3×6px markers and a 1px gauge all stay readable on
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
  pair, the version tile and the back key to fill all 13 buttons, so an eighth
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
  for a terminal there and learns what actually happened here. Reads
  `~/.claude/streamdeck-windows/<extension host pid>.json`, one per open VS Code
  window, carrying that window's folders, whether it's focused, and which
  session's terminal is in front. **Synchronous on purpose** — its only caller
  is `deck.on("down")`, a synchronous handler, so an async read would resolve
  after the press was already decided. **The filename is the liveness handle**:
  named for the extension host's own pid, a window that has gone away is
  detected exactly with `isAlive` rather than guessed from a timestamp, which
  is what lets the extension write only on change instead of heartbeating a
  file every 400ms in every open window forever.
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
  that file rather than inline here, for the same reason. It also does the two things
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
  usage endpoint, and writes exactly one file: `~/.claude/streamdeck-focus.json`,
  the terminal-focus request.
  There is a second file in this feature and the daemon does **not** write it:
  `~/.claude/streamdeck-windows/<pid>.json` is published by the extension and
  only read here. Keep it that way — a daemon that deletes files it did not
  write is a worse trade than leaving that sweep to the extension, which
  already does it (`reapDeadWindows()`, on every `activate()`): a crashed
  window's file would otherwise sit until its pid is recycled onto an
  unrelated process, at which point the liveness check starts trusting a
  frozen `focused`/`activeSessionId` from a window that died weeks ago.
  An earlier hook-based version was deleted; don't reintroduce one.
  A remote host bends "writes exactly one file" further than that: a fetch
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
- **One install step, in the status line.** Context usage is the exception to
  the above: Claude Code hands a session's context percentage to the status
  line and nowhere else, so `~/.claude/statusline-command.sh` writes it to
  `~/.claude/ctx/<session id>.json` for the daemon to read. That block is
  quoted in `README.md`. If a machine has no status line, or the block is
  dropped, the gauge simply doesn't draw — never make a missing file an error.
  Don't be tempted by the transcript's `usage` totals instead: the percentage
  needs the model's window size (1M on some, 200k on others), which the
  transcript doesn't record.
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
  running the *old* code until `Developer: Reload Window`. That is why
  `ext:install` ends in an `echo` saying so. An automatic upgrade nobody
  notices is worse than a manual one they do — the copy is silent, the
  mismatch is silent, and the only symptom is a fixed bug that appears not to
  be fixed. The `mkdir -p` in that script is not decoration either: without it,
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
  app cannot run alongside). The last two are reserved — key 14 (bottom-right)
  is the usage readout and the stats toggle, key 13 the attention key — leaving
  **13 session slots**. Extra sessions past that are dropped silently, by
  design.
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
