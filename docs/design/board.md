# The board: slots, views, presses, restart (index.mjs)

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/index.mjs` — daemon loop, slot assignment, focus. Exports `assignSlots`,
  `accentFor`, `attentionQueue`, `detailLayout`, `pageOf`, `restartDecision`,
  `resumeView` and `stillUnread` for the checks — the rule, which outlives any
  list of names, being that anything deciding something the hardware would have
  to show you gets to be a function with a case in `slots-check`; the `import.meta.url === argv[1]` guard at the
  bottom is what keeps importing it from starting a daemon. Also owns **which
  board is showing**: one `view` value local to `run()`, never a flag per
  board, so "stats and detail are both somehow on" isn't representable. Its six
  kinds — `sessions`, `stats`, `attention`, `busy`, `free`, `detail` — each
  have one branch in the poll loop and one `refresh*` function, and the same 12
  session keys are redrawn by whichever is current. Which *page* of a queue
  board is showing is the one thing held beside `view` rather than in it
  (`queuePage`, reset by `setView`): a page is a position within the current
  view, not a second thing that is on. The `drawn`-signature diffing does the switching for free: signatures
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
- **Ordering is first-seen, never activity.** `sessionOrder` in `index.mjs` is
  an append-only map for the daemon's lifetime, and `projectOrder` is an
  append-only array. Folders are deliberately kept after their last session
  ends so a returning project reclaims its slot and accent colour. Anything
  that re-sorts a settled board breaks the point of the tool: muscle memory for
  where a button is.
  **It survives a restart, and it is the last piece that learned to.** Accent,
  project position, project name and the board's own port and token all
  persist; `sessionOrder` did not, so a restart rebuilt it from whatever order
  the sources happened to report and reshuffled every session *within* its
  project's block — invisible on a machine with one session per project, and
  the whole point of these rules on one with six. `seedSessionOrder` reads it
  back from `~/.claude/streamdeck-sessions.json`, which already holds exactly
  the non-nested sessions the ordering is over, so this is a second job for a
  file rather than a seventh file — and `liveSessions()` now publishes in board
  order, which nothing read before and which is the only thing that made that
  file usable here. Ids that died meanwhile are seeded and then dropped by
  `assignSlots`'s own prune on the first poll; new sessions still land after
  everything remembered, because `arrivals` has already walked past them.
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
  **The slot cap is the third exception, and the narrowest** (`promoteActive`).
  At 13 slots first-seen alone hides the session actually doing the work: the
  board is full and the busy one arrived last, so the key that matters isn't
  there. A session past the cap trades with the least active session *of its
  own project* and takes its exact slot — so no block moves, no project changes
  size, no accent changes, and a board under the cap takes a path identical to
  before. It fires only when something was cut, and ties never swap, which is
  what keeps first-seen the default: equally idle sessions are exactly the case
  with no reason to move anything. Repeated "replace the least active if this
  one beats it" leaves a project's K slots holding its K most active sessions
  whatever order the cut arrives in — pinned by a check, because the input
  order is `readdir`-dependent. Only a project straddling the cap can be
  affected by `promoteActive` on its own (one with nothing visible has no
  sibling there to trade with) — see `guaranteeRepresentation` below for the
  case that used to leave such a project with nothing at all. "Active" is the state the key would
  *show* — `mostUrgent` over the session plus its parent-matched subagents,
  tie-broken by `ts` — never the session's own `state`: the case this exists
  for is a controller sitting idle while every bit of its work happens in
  Agent-tool subagents, which by its own status is the least active thing in
  the project. `ts` reads the right way round for both halves without a special
  case: among equally idle siblings the one that went quiet first is the least
  active, and among equally busy ones the freshest is the one that just
  started. The honest cost, stated rather than discovered: a key at the cap
  boundary can now change identity while you are looking at it, which is the
  first time a session key's occupant changes without a session starting or
  ending. `boardTiles` is untouched — the iPad has no cap, so it has nothing to
  promote, and the two views can disagree about which session sits third in a
  block when the deck is full.
  **The fourth exception, and the one that isn't about activity at all:
  `guaranteeRepresentation` makes sure every project with a live session gets
  at least one slot**, run just before `promoteActive` on every poll that's
  over the cap. `promoteActive` only ever trades *within* a project that
  already holds a slot — a project that arrived late enough to land entirely
  past the cap has no sibling of its own there to trade with, and used to
  simply have no key at all. A key has muscle memory for where its project's
  block sits; a project with zero keys has none to remember, which is worse
  than a key moving. The fix is a set-membership swap, not a positional
  one: evict one session id from a donor project, admit the starved
  project's, and let `assignSlots`' existing `ordered.filter(...)` re-derive
  where everything sits from the one global first-seen sort — that's what
  keeps every block contiguous for free, same as the unbent board. The donor
  is whichever project currently holds the *most* visible slots (never one
  down to its last), and what moves on both ends is first-seen: the donor
  gives up its oldest visible session, the starved project's own oldest is
  what takes the freed slot. If every visible project already holds exactly
  one slot there is no donor to find, and a live project count over the slot
  count is a seat that genuinely doesn't exist — left unseen rather than
  starving a sibling down to zero chasing it.
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
- **The daemon replaces itself when the version moves, and that is the only
  thing it does to itself.** `restartDecision` compares `package.json`'s
  version against the one loaded at start, and `restartInto` calls
  `process.execve` — not a supervisor, not a wrapper script, not a launchd
  job. The reason is that this daemon *prints things a person reads*: the board
  URL, the QR code an iPad is scanned from, which windows still need reloading.
  `execve` keeps the pid, the terminal and stdout, so all of that still lands
  where it was going; under launchd it would go to a log file nobody opens,
  which is a real loss rather than a cosmetic one. Verified before it was
  written: a scratch program exec'd itself three times keeping one pid.
  **A changed version starts a clock, never a restart** (`RESTART_SETTLE_MS`,
  5s). A `git pull` is not atomic — `package.json` can land seconds before the
  source it belongs with — and exec'ing into that gap runs a tree that is half
  one release and half another. An **unparseable** `package.json` is not "no
  version" but "ask again in two seconds", so it waits rather than resetting
  the window: mid-write is the normal state of a file another process is
  rewriting, and a window that reset on every unreadable read would fire in the
  middle of the write it exists to wait out.
  **Open fds survive an exec unless they carry `FD_CLOEXEC`, and the two here
  differ** — measured, not assumed. libuv sets it on everything it opens, so
  the listening socket frees itself: a program that exec'd itself while still
  listening re-bound the same port cleanly. The HID handle is a native addon's
  fd with nobody setting that flag, so a deck left open would still be held
  exclusively and the new image could not open it. The socket is closed anyway,
  because the failure it prevents — an ephemeral port, and the iPad bookmark
  `board-state.mjs` exists to keep alive silently dead — is one nothing on the
  board would report; the close is bounded by a 1s race, since `server.close()`
  waits for live connections and the board page holds one open by polling.
  The `execve` check happens **before anything is closed**: without an exec to
  follow it, closing the deck and the socket would leave a dead board on a
  daemon that then carries on running.
  It re-execs `node src/index.mjs` directly, so `prestart`'s prompts are
  deliberately not repeated — an extension-install question on every release,
  answered while you are looking at something else, is how a prompt stops being
  read. The daemon's own per-poll "reload these windows" line covers that side.
  And the cost of a restart is now paid more often, which is the whole reason
  `sessionOrder` had to learn to persist first: see the ordering invariant.
  **The restart says so on the keys**: every key black, the fifteen letters of
  "NEW VERSION START" in white, then each turning green left to right across
  `SPLASH_MS` (4s). Fifteen letters on fifteen keys with no remainder is what
  those words buy; they **wrap** (`NEWVE / RSION / START`) and there is no
  layout where they don't, because the deck is five columns and VERSION is
  seven letters. Spanning letters across key boundaries is not an option on
  this hardware — the keys are not contiguous pixels, there is black plastic
  between them, and a letter cut by the bezel is one nobody can read. Change
  the words and the constraint is the count: 5/5/5 is the only shape that
  also lands a word per row.
  **The sweep runs in the *old* process, before the exec**, which is the only
  place it can: the new image is up in well under a second and would have to
  stall on purpose to show anything. So it is the restart's actual progress
  bar rather than a splash screen — while it runs, the daemon you are watching
  is still the outgoing one. Four seconds is deliberately longer than the work
  needs: a board that changes with no explanation is what this exists to
  prevent, and a restart nobody saw is indistinguishable from a glitch.
  `SPLASH_MS` is the **whole** sweep and the per-letter interval is derived
  from it, so adding a word cannot quietly stretch a restart.
  **`pulse()` had to be stopped for it.** It runs on its own 400ms tick and
  would blink a `requires_action` key straight through the middle of the
  splash, which reads as the update having gone wrong. `isRestarting` is the
  overlay boards' rule reached the one way they cannot use — nulling
  `renderParams` would throw away what this process still needs if the exec
  turns out to be impossible — and it *skips* rather than exits, so a deck
  that can't be exec'd away from is still animated by the only loop left.
  **The board you were on comes back** (`resumeView`), carried in the
  environment because that is the one thing that survives replacing a process
  image; a file would be a ninth one, for a value that is meaningless two
  seconds later. Only `kind` and the detail board's `session_id`: `tiles` are
  recaptured on the new process's first poll, which is what `holdTiles` is
  for, and a queue board's **page is deliberately dropped** — landing on page
  3 of a queue that re-ranked while the daemon restarted is a page nobody
  chose. It is validated against a closed set of board kinds, because the
  value reaches the poll loop's own board dispatch and a kind that isn't a
  board leaves the daemon drawing nothing at all.
- **The poll loop's board branches are the part nothing checks, and one of them
  was deleted without anyone noticing.** `refreshStats` was removed by an edit
  aimed at the function *above* it — a text slice that reached further than it
  looked — and the daemon went on running: `run()` catches a throw per poll and
  prints `refresh failed:`, so the stats board simply stopped updating while
  everything else worked and the process looked healthy. It took pressing the
  key to find out, two commits and a push later. `refreshStats` is now exported
  and driven against a fake deck in `stats-check` (a `fillKeyBuffer` that
  records), which is the only one of these four functions a check can reach
  without hardware — the other three call `liveSessions()` themselves. When
  editing near them, prefer an anchored edit to a slice between two comments.
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
- **MK.2 hardcoded-ish**: 15 keys, 72×72, macOS only, exclusive HID (the Elgato
  app cannot run alongside). **Two keys are reserved** — key 14 is the usage
  readout and the stats toggle, key 13 the status key — leaving **13 session
  slots**. Extra sessions past that get no key, by design.
  **The status key is two keys folded into one, and the fold is the point.**
  It was an attention key and a free-capacity key side by side, which spent a
  slot saying two things that are never both the answer: "10 sessions free" is
  not what you want to read while two are blocked on you, and once nothing is
  blocked the blocked count is a zero nobody needs a key for. `statusKey` picks
  — attention whenever that queue has anything, then **memory** when this
  machine's RAM pressure is over `MEMORY_ALERT_PCT` (70: the attention key's
  red with the percentage where the count goes, and a press opens the stats
  board, where the memory key is), and the **session total** otherwise. An
  alarm still opens exactly what it is alarming about, so a red or a pressure
  key can never open a board it never mentioned. It is exported and pure for
  the reason `detailLayout` is: it is written into two boards (this deck and
  the web one) and neither is visible without the hardware or a browser, so
  the fold is a rule rather than a branch each board decides for itself.
  Only the attention side caches `renderParams`; the resting side nulls it,
  since only one of them pulses and stale params would let `pulse()` redraw an
  attention frame over a quiet key.
  **The key names the board you are on, never the one a press would open.**
  Resting it reads `14 SESSIONS`; on the busy board `9 WORKING`; on the
  inactive board `5 INACTIVE` — one `drawQueueOnStatus` for both of those,
  differing only in the word. **The label is `INACTIVE`, the code is
  `freeQueue`/`freeCount`/`view.kind === "free"`**, and that split is
  deliberate rather than drift: "free" is what the queue *means* to the
  scheduler-ish half of this file (capacity, where the next piece of work can
  go), and "inactive" is the honest thing to say about a session on a key —
  a session sitting idle is not being offered to anyone. Same trade the
  `offline`/`unreachable` key makes one screen over. It used to tease the *next* leg instead (the busy count
  while the inactive board was up), which put a number on the key describing
  neither the board under it nor anything else on screen. The count is
  non-nested sessions only: a subagent has no key of its own, so it is not one
  of the things "14 sessions" is counting. There is no age line under the
  resting count — "longest idle" says something under an inactive count and
  nothing under a total.
  **One cycle, and the status key is the only thing that walks it: attention →
  working → inactive → out.** Working comes before inactive because what the
  machine is *doing* is the more common question, and it is the half of the
  total that moves minute to minute; inactive is the one you go looking for
  when you want somewhere to put the next piece of work. Attention leads
  whenever it has anything, which is the same order `drawStatus` draws in — an
  alarm still opens exactly what it is alarming about. **The attention board
  was a dead end for three releases**: its status key exited like every other
  key there, so the one board you reach most often was the one you could not
  continue from. It continues now, and the three press branches that used to
  say this separately collapsed into one. `nextLeg` is the single place the
  order lives, shared with the resting press so the two cannot drift, and it
  **skips an empty leg** rather than opening one for the poll loop to drain a
  tick later — which reads as a key that flashes a board at you. That is what
  `busyCount`/`freeCount` are doing in the press handler, and why every
  `drawStatus` call site destructures them. Every *other* key on those boards
  still exits and focuses, unchanged: the cycle belongs to the status key, not
  to the deck, and that is the way out at any point.
  **A queue that overflows the 12 session keys pages, and the same press walks
  the pages first** (`pageOf`). The key's third line becomes `2/3 · 4m` and a
  press advances the page until there are none left, then moves to the next
  board. Pages come first because a second page is part of the board you asked
  for — a `2/3` the key would not let you reach is worse than not drawing one.
  Three things it does *not* page: the **count** stays the whole queue's
  (`12 WORKING` meaning "12 on this page" is the same lie the key told when it
  named the next leg), the **age** stays the whole queue's (so "longest
  waiting" is still true on page 3), and the busy board pages over its
  **tiles** rather than its queue, because a session draining off still holds a
  key for five seconds and has to fit somewhere. `pageOf` **clamps rather than
  blanks**, and that is load-bearing: these queues re-rank every poll by
  design, so the page you are on can stop existing under you, and a queue
  shrinking from three pages to one has to land you on the page it still has
  rather than on twelve dark keys that read as a dead daemon. The press handler
  clamps from the other side too — it compares against the page count the last
  poll actually *drew*. The page is **one value for all three boards**, reset
  by `setView`, rather than a page per board: only one queue board can be
  showing, and a page is a position within the current view, not a second thing
  that is on. Neither renderer changed — the line is a string, measured on a
  real raster first: the worst realistic case (`12/13 · 1h 20m`) is 53px of 72.
  **A session that stops working drains off that board rather than
  vanishing** (`busyBoardTiles`, `BUSY_LEAVE_MS` = 5s). On a board whose whole
  content is "what is running", a session finishing means a tile disappearing
  between two polls with nothing to say it was ever there — and a key that
  vanishes reads as one you must have mis-seen. It keeps its key for five
  seconds, drawn in its *new* (idle) colour with a bar draining to nothing
  across the task-counter row, and only then drops off. Three things in it
  are load-bearing. Ordering uses the `ts` the session had **while busy**, not
  its live one: going idle restamps `statusUpdatedAt`, so the live value would
  fling a departing key to the end of the board on the very poll it starts to
  leave. Departures are **absolute deadlines**, not fractions, because the
  poll computes them every 2s while `pulse()` redraws them every 400ms — a
  fraction fixed at poll time would step four times per redraw and read as a
  stutter. And the status key's count and the poll loop's leave-when-drained
  test both use the *real* busy queue, never the drainers: the number answers
  "how much is running", and holding the board up for five seconds after the
  last session stopped would show nothing but bars.
  **This is the one thing an overlay board animates**, which is why the drain
  params live on `btn.leavingParams` rather than `btn.renderParams` — that
  field is nulled by every overlay board precisely so `pulse()` finds nothing,
  and the invariant stays exactly as strict as it was. `pulse()`'s own branch
  is gated on the *live* view being `busy`, so leaving the board stops the
  redraws on the spot rather than one poll later, when the params are
  overwritten. `busyQueue` mirrors `freeQueue` exactly (same
  fold over own state plus nested subagents', same longest-first ranking, just
  filtered on `"busy"` instead of `"idle"`) for the same reason: a session
  whose Agent-tool subagent is still running must read the same on both queues
  as it does on the board. `drawQueueTiles` is the one function all three
  boards' key-drawing now goes through — extracting it is what surfaced
  `refreshAttention` returning an undefined `count` (a stray singular where
  `counts` was meant) instead of the counts the poll loop needs to know when
  to leave a drained board; that had been silently breaking the attention
  board's own empty-queue exit since whenever it was introduced.
  **The board page is where that cap does not apply** (`board-page.mjs`): an
  iPad is not this device, so it shows every session and scrolls. That is not a
  second answer to "what falls off the end" — the two queues are still the
  complete ones — it is the same board without a constraint that is a fact
  about 15 keys of 72px and nothing else.
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
  The slot that fold gave back went to the sessions. "Blocked today" had a
  stats tile for a while and now lives only on the activity page; its
  `blockedTodayTile` stays cached 30s because `readHistory()` reads the whole
  log and that page's status is polled.
  `freeQueue` folds nested state exactly as `refresh` does
  (`mostUrgent([own, ...nested])`), or a session whose Agent-tool subagent is
  still running would be offered as free while its own key two rows up reads
  busy. `shell` is likewise not free. Its own board truncates at 12 like every
  other, but ordered longest-idle first rather than by first-seen, so what
  survives truncation is the most obviously spare — a defensible cut, unlike
  the sessions board's arbitrary tail.
  The inactive side is **never coloured and never pulses**: green already means
  "working" everywhere here, so a green key for "not working" would fight the
  palette, and nothing on it is wrong. Dark with a big white number, like the
  usage key it sits beside — which is also what makes the fold read cleanly,
  since the attention side going red is then the only colour that key ever
  shows.
  The stats board is cswap's, active account first: two keys per registered
  subscription (`cswapTiles`) — its usage in the bottom-right key's own shape
  (session % / week %), then its resets in the same shape with the time left
  in place of a bar — both titled with the account's local part and bordered —
  busy green on the active one, grey otherwise, which is the subscription the bottom-right key also
  describes. `renderUsage` grew `title`/`active`/`rows` for this rather than
  a second renderer, so the usage key and these can't drift apart; a value's
  font is sized off the row rather than the key because a titled row is a
  fifth shorter. Then a memory key in the same shape (`memory.mjs`: RAM
  pressure off `kern.memorystatus_level`, swap in use off `vm.swapusage` —
  not `os.freemem()`, which macOS's file cache keeps near zero on a healthy
  machine; no border, since it's neither active nor inactive — and **a press on
  any memory key flips all of them between % and GB** (`memGb`, held outside
  `view` so it survives leaving the board; the bar stays under the amount, so
  red at 90% is red at 57 GB), a key per reachable host in the same shape,
  the version right after the accounts; and the memory keys start the **next
  row** (padded only while they still fit above the back key), so two
  subscriptions read as row one and the machines as row two; back at 10,
  config at 11, key 12 blank.
  Sliced at `DETAIL_BACK_INDEX`, so a fifth account falls off rather than
  under the back key. The all-time stats, the account name, the reset pair
  and blocked-today all left the deck — every one of them is on the activity page, and a
  machine without cswap sees only the version here.
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
- **A key's caps bar is always the project name**, the matched window's
  folder — never the session's cwd. A worktree agent belongs to its project and
  says so, so two agents in one repo both read `KOB-TRACE` and are told apart
  by their body text, which is the field that actually differs between them.
- **A key's colour covers its block; every other field is its own.** `refresh`
  takes `mostUrgent([own state, ...nested states])` for the background, so a
  project whose only activity is a subagent reads as working rather than
  sitting grey behind a 3×6px marker — subagents have no key, so this is the
  only way their state reaches one. The title, context gauge and task counter
  still describe the key's own session: a subagent can speak for "is anything
  happening here", not for "what is this key about". `state` is the block's, so
  `renderKey` takes a separate `shell` flag for the margin's blue dot; without
  it a key greened by a subagent would erase its own background-shell marker.

