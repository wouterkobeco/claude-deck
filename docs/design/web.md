# The web pages: config, activity, board

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/config-server.mjs` — the config page: a local web UI, served by the
  daemon on loopback and opened from the stats board's config key, for setting
  which accent each live project wears, and — on its second tab, **Activity** —
  for the charts nothing on a 72px key could carry: output tokens per hour,
  input tokens per hour on a chart of their own (two orders of magnitude
  bigger here, so a shared axis flattens output; stacked fresh / cache read /
  cache write, since how much was cache is the question), the output split
  by model, sessions in parallel per hour coloured by state, and
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
  **The stats board's numbers live on top of it** — the two rate-limit windows
  as meters with their resets, today's blocked time, the all-time totals, the
  version. They had a page of their own for three commits and it was one page
  too many: it duplicated this page's header, its shape and its purpose, while
  splitting "how am I doing" across two taps. They sit **above the window
  picker** because no window applies to them — a 5-hour rate limit is not a
  thing you look at "over 30 days" — and they come from `deps.status()` rather
  than `deps.activity()`, kept apart because the two are cached on completely
  different clocks (`getUsage` 5m, `getStats` and blocked-today 30s, against a
  regroup of records the picker drives).
  **A rate-limit meter's title states its own reset**: "Session resets in 5
  hours" rather than a static "Session · 5 hours" caption plus a "resets in
  5h" line underneath, which said the unit twice — and the caption's "5
  hours"/"7 days" was never information anyway, just the window's own fixed
  length. When the reset itself isn't known, `resetRow` doesn't fall back to
  a caption at all — the whole row collapses to one centered line, "Session
  reset time is unknown", and nothing else: no bar, no percentage, since a
  number beside an unstated reset reads as "we know the figure but not the
  clock" when the honest answer is "we don't know either". `.limit` is a
  centered flex column with a floor height (`min-height`) precisely so that
  one-line card isn't shorter than its four-line neighbour — CSS grid's own
  row-stretch only equalises cards sharing one `.limits` container (each
  account gets its own), so the floor height is what keeps every rate-limit
  card on the page the same height regardless of which account it belongs to.
  **Under "Rate limits": every cswap account, or the plain pair without
  cswap — never both.** The active account leads that list and already
  carries the daemon's live numbers, so drawing the plain pair above it said
  the same thing twice. Then memory. All of it reuses the `limits` meter pair — the memory one with its own captions and no reset
  line, which is what the optional second argument and an `undefined` reset
  are for — so a meter looks the same whatever it measures. The swap meter
  carries a `title` tooltip saying it is occupancy, not activity: a long
  uptime parks cold pages in swap and the number sits high while nothing is
  wrong (87% on a 36-day-uptime Pi, measured), so a red-looking figure needs
  the caveat right where it is read — pressure, the meter beside it, is the
  one that alarms (`MEMORY_ALERT_PCT` tests `pressure` only, never swap).
  **The account name sits under "Rate limits", not beside the version.** It's
  the same `getAccountName()` the deck's own stats board reads, off
  `~/.claude.json` rather than the OAuth token — the two are on this page
  because it's the one place both a plan and a name make sense together.
  **The period links used to be plain `<a>`s — a real navigation on every tap,
  full reload, scroll thrown back to the top.** `ACTIVITY_SCRIPT` intercepts a
  click on one, fetches it, and swaps `document.body` — the same shape as the
  accents page's own drag script (fetch, `DOMParser`, `replaceChildren`), just
  triggered by a link instead of a form. `pushState` keeps the URL tracking the
  window picked; `popstate` re-fetches so the back button isn't left showing a
  page that disagrees with its own URL.
  **The pie centres itself only once it's actually alone on a row.**
  `.split`'s `justify-content:center` looks like it should center the table too,
  but the table's `flex-grow` fills the row completely while they're side by
  side, so there's no leftover space to center against until the pie wraps
  onto a row of its own.
  **Five period tabs is more than the fixed padding/font fit on an iPhone
  SE's ~351px of content width.** `.periods`' gap, padding and font are all
  `clamp()`s that shrink together as the viewport narrows, rather than
  wrapping to a second row or overflowing into the horizontal scroll the rest
  of the page just gave up.
  **Its type is sized for a tablet, not for a laptop it is leaning on.** The
  page was 760px of 13px table in whatever window it opened in, which is fine
  on a Mac two feet away and a column of small print on an iPad — and the iPad
  is now a first-class reader of it, since the board's stats icon is how you
  get here. `main.wide` is 1180px, the table is 17px, the column charts are
  170px tall and the pie is 240px; the body's side padding is a `clamp` so a
  phone loses the margin rather than the content. Nothing here is per-device:
  one set of numbers that is honest at arm's length reads fine at two feet,
  and the reverse was what was wrong.
  **`PERIODS` in `index.mjs` is the whole window feature** —
  12h/24h/7d/30d/3mo/6mo/1y/all-time, each with the bucket it groups into,
  chosen to keep the column count in the 24–52 band (fewer and a bar chart is
  a table; more and the columns are thinner than the gaps). 6mo is 3mo
  doubled at double the step (4 days rather than 2), landing back on 3mo's
  own 45 columns rather than drifting past 52. 1y is a capped year at "all"'s
  own weekly step (53 columns); "all" itself is whatever is actually
  open-ended past a year. Every other step is a whole number of hours because
  the stored records *are* hourly, so changing window is a regrouping rather
  than a re-read — that is why a year of history costs the same page load as
  a day.
  **12h is the one period whose step goes below an hour** (15 minutes, 48
  columns) — short enough that sub-hour resolution actually shows something a
  coarser bar wouldn't, and the concurrency/memory series can genuinely
  provide it: `concurrency` buckets at whatever `step` it's given with no
  floor of its own, and `memorySeries`'s floor is `TICK_MS` (5 minutes, the
  tick's own cadence) rather than an hour. Tokens can't follow: a transcript's
  usage is logged in whole-hour buckets (`summariseTokens`'s own floor), so
  its chart stays 12 columns regardless of what `step` asks for. That split
  is why `activity()` carries **two** tick functions rather than one —
  `tickAt` for concurrency/memory, sized off the real `step`, and
  `tokenTickAt`, sized off `tokenStep` (`step` re-floored to the hour the
  same way `summariseTokens` floors its own buckets) — because sharing one
  would label the token chart's axis for 48 columns it doesn't have, using a
  `cols` count computed for a bucket size tokens were never going to use.
  `unit` (the token peak's "peak X/‹unit›" label) stays `"h"` for 12h rather
  than `"15m"`, for the same reason: the number really is a peak-per-hour,
  regardless of what the period's own headline step is. The window arrives
  as `?p=`, and the page renders
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
  **A project's name can be overridden from the same page.** Hovering a
  row's name swaps it for a text input in place — same box, so nothing
  reflows — without moving focus there, since a mouseover that stole focus
  would yank it away from whatever else you were doing on the page; Enter or
  losing focus (click elsewhere) is what saves, over `POST /rename`. Storage
  is the same file and the same shape as an accent: `accents.mjs`'s
  `readProjects`/`writeProjects` grew a third map (`names`, keyed the same
  way) and a third field on each record (`name`), read into a module-level
  `folderNames` in `index.mjs` beside `folderAccent`. `applyRename` is
  trim-and-set or trim-to-empty-and-delete — clearing the field is how a
  rename reverts to the folder's own basename — and unlike an accent there is
  no contention to resolve: nothing stops two projects sharing a label, and
  policing that isn't this feature's job. **One map, every place a project's
  name is shown**: `keyFields` (the deck's own caps bar, looked up by
  `folderKeyFor` so two hosts sharing a path can rename independently),
  `liveProjects` (the config page's list and the activity page's project
  table both read off it), so a rename reaches the deck without a separate
  wiring path at each site.
  **A renamed row also gets a reset icon**, shown only on that project —
  `configDeps.projects()` exposes `renamed: folderNames.has(key)`, a presence
  check rather than a string comparison, because a custom name can coincide
  with the folder's own basename and that's still a rename. It's rendered on
  hover of the whole bar rather than the name specifically: the name itself
  becomes an `<input>` the moment it's hovered, so a CSS rule keyed to
  hovering *it* would stop matching the instant the swap happens. Clicking it
  clears the override outright — `POST /rename` with an empty name, the same
  request an emptied edit box sends — with no edit step of its own.
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
- `src/board-page.mjs` — the whole board as a web page, for an iPad propped up
  beside the deck. Same sessions, same folding, same palette (`STATE_COLORS`,
  `MARKER_COLORS` and `usageColor` are imported, not re-picked, so
  `colors-check`'s floors still cover what an iPad shows); what it does not
  inherit is the deck's *geometry*, and that is the whole design.
  **There is no slot cap**: an iPad is not 15 keys of 72px, so every session
  gets a tile and the page scrolls, which is also why the three reserved keys
  are appended to the tile list rather than pinned to indices 12–14 that only
  mean something on a 5×3 device. Columns, rows and font size come from the
  gear or the corner grip and live in `localStorage`, never on the daemon — they
  are facts about *that screen*, and a phone and an iPad looking at the same
  board want different ones.
  **One number scales a key.** Everything inside a tile is sized in `cqh`/`cqw`
  against the tile itself, so rows and `--fs` move the caps, the body, the
  markers and the task squares together — the deck's own proportions, without a
  second layout to keep in step.
  **A key is square, in both directions, on any screen.** Rows set its height
  and columns its width, and those two numbers are nothing like each other on a
  real device: a portrait phone makes a key three times taller than it is wide,
  and rotating the same phone makes it a letterbox. `--key` is the `min()` of
  the two and is used *twice* — as `grid-auto-rows` and as a `max-width` on the
  tile, so a column wider than the key leaves space beside it rather than
  stretching it. Capping only the height was the first attempt and fixed
  exactly half the problem, which is the half that happens to be portrait.
  **The layout is remembered per orientation**, and a first sight of each fits
  itself: rows come from the height against a target key size (~120px on a
  phone, ~190px on anything bigger), columns follow from the key that produces,
  and the font is the share of that key landing near 18px. One shape cannot
  serve both — 3×6 is right for a portrait phone and absurd on the same phone
  turned sideways. Re-applied on `resize` rather than `orientationchange`: the
  latter is deprecated and fires before iOS reports the new dimensions, and
  only a *change of orientation* re-applies, so every other resize just
  re-measures the line count. **Deliberately not a device test**: iPadOS Safari
  reports a Mac user-agent by default, so "is this a phone" is a question the
  browser will lie about, while the dimensions are the thing that was wrong.
  **An element is never its own container**, and `.tile` *is* `.key` — so its
  `padding: 4cqh` resolved against `<main>`, not against the key, and came out
  12.7px instead of 3.9px on a landscape phone. That squeezed the usage tile's
  contents into 71px of a 97px key and clipped them. Percentages there instead;
  every other `cq` unit in this file is on a descendant, where it means what it
  looks like it means.
  **The reserved tiles size their type to the key, not to `--fs`.** That slider
  sets how much of a session *title* you can read, and those three tiles hold
  no title — a count, a caps label, an age. Scaling them with it meant a font
  chosen so four lines fit a session key overflowed a tile carrying two
  percentages, two labels and two bars.
  **`--lines` is renderKey's `maxLines`, measured rather than derived**, because
  only the browser knows how tall a key ended up at this rows/font pair. It is
  taken from the *smallest* body on the board, not the first one: a key carrying
  task squares has less room than one without, and a count taken off the roomier
  kind overflows the tighter one — which is exactly the half-line that showed up
  under the progress bar. `-webkit-line-clamp` alone was not enough either: it
  puts the ellipsis on the last line it keeps and then paints the line after it
  anyway when the element was stretched to a taller flex box, so `.text` also
  carries `align-self: flex-start` and a `max-height` that clips whatever it
  paints.
  **The poll diffs rather than swaps.** Replacing the grid every 2s restarts
  every CSS animation, so a `requires_action` tile would stutter on a 2s cycle
  instead of blinking at 0.8s. `tick()` compares each incoming tile against what
  is in the DOM and touches only what changed — `btn.drawn`'s idea, in the one
  place that has to be the browser. That is also why the beats are CSS
  animations and not a network event: `pulse()`'s 400ms tick has no equivalent
  here and needs none.
  **A second tap opens the detail panel, and it is deliberately not the deck's
  detail board.** That board spends most of its design on fitting one session
  into 5×3 keys of 72px — `taskWindow` re-centring so the in-progress task
  stays visible, subagents pinned to a tail so a twenty-task plan cannot push
  them off, a back key carved out of a fixed index. None of those constraints
  exist on a page that scrolls, so `detailPanel` shows the *whole* task list
  and every subagent, and nothing is cut to fit a square.
  **It's also the one place a session says which subscription it's running
  under** (`Account`, in the same facts list as Context/Model/Where) — the
  deck's own detail board doesn't carry this: its four header tiles already
  cost one task slot each out of fourteen, and this is the one fact the web
  panel can show for free. A local session reads it off `getAccountName`
  (this machine's own `~/.claude.json`, already cached); a remote one's is
  `fetchAccountName` in `remote-fs.mjs` — the *one* thing this project reads
  from a remote host outside the regular 6s poll, fetched only when a human
  actually opens that session's panel, reusing that host's own poll
  connection's `controlPath` so it rides the already-open `ControlPersist`
  socket rather than a fresh handshake. On demand rather than polled for the
  same reason `getAccountName`'s own comment gives for the local file: it's
  100+KB and changes only on a login switch, not worth asking about
  fourteen times a minute for every host whether anyone is looking or not.
  `parseAccountJson` is the pure half — same displayName-then-email
  preference `getAccountName` uses — so the untestable part is only the ssh
  call itself, the same split every other remote read here makes. Two hosts
  really can differ: a `cswap switch` here doesn't touch what a remote box
  is signed into, which is the whole reason to ask per session rather than
  once for the board.
  **It also totals what a session has spent** (`Tokens`, in the same facts
  list): `transcriptTokenTotal` sums `message.usage` straight off the
  session's own transcript — the hourly log cannot answer this, because its
  buckets are keyed per hour/cwd/model and throw per-session identity away by
  design — via `subagentTranscriptPath` for an Agent-tool subagent's row. On
  demand, once per panel open, never on a poll — the same trade
  `fetchAccountName` makes. A remote session's transcript never lands on this
  machine (only its tail does, for the ctx gauge), so it reports null rather
  than a wrong number.
  **The repeat rule is decided in the browser, and that is right rather than a
  shortcut**: the deck's `lastPress` is per-deck, and per-client is what the
  equivalent is here — two people looking at one board must not steal each
  other's second tap, and the daemon cannot tell them apart. Everything else
  about the rule is the deck's: both taps raise the window, any other tile
  breaks the chain, and leaving clears it (without that the tap that closed
  the panel is still in `lastTap` and the next one reopens what you just left).
  The panel is re-rendered rather than diffed, because the age in its header
  ticks by the second for the first minute of a state — so it saves and
  restores `scrollTop`, or a long task list you were halfway down would jump
  to the top every 2s.
  **The body font is a proportion of a key, and copying the deck's ratio was
  wrong.** 19% of 72px is 13.7px seen across a room; 19% of a 226px tile is
  43px, which is why every title was cut off at three lines. The default is 9%
  on a tablet and 11% on a phone (whose key is half the size and so needs a
  bigger share of it), which fits five lines and four — and it is a slider,
  because how far away the thing is sitting is not something this can know.
  **The usage tile is a plain anchor to the activity page**, not a click
  handler: it is a navigation, the way the deck's usage key opens the stats
  board on a press, so it needs nothing from `SCRIPT` and the poll's markup
  diffing treats it like any other tile.
  **A saved icon has to open a board, not a 403.** The page ships a manifest
  and PNG icons (`renderIcon`, in `render.mjs` with the rest of the SVG→sharp
  work rather than as a checked-in file — the palette is already there, and a
  committed PNG is a second copy of these colours to keep in step). Both sit
  behind the same token gate as everything else and are linked *with* the token
  in their href, because `start_url` has to carry it — that is the only reason
  any of this is more than three meta tags. Installing is a tap the platform
  owns: Android's `beforeinstallprompt` lets the gear offer a button, iOS has
  no equivalent at all, so the sheet says where Safari's own menu item is
  rather than pretending.
  **A stopped daemon must say so.** Three failed polls grey the board and say
  `daemon not responding`, for the same reason `unreachableHosts` exists — a
  frozen board is indistinguishable from a quiet one, and that is the one
  dishonest thing this project refuses to ship.
  Everything else is decided on the server, the rule `config-server.mjs` already
  lives by: what a tile says, what colour it is, whether a gauge is critical,
  which tiles are tappable (`data-session` is emitted only for session tiles, so
  the reserved three and an unreachable stand-in are inert by construction
  rather than by a check in the handler).
  **`HEADER_SCRIPT` is exported alongside `HEADER_CSS`/`iconHeader`, for the
  same reason those are: a gesture that only worked on one of the three pages
  sharing the header would be a worse bug than not having it.** Every page's
  own CSS blocks horizontal scroll (`overflow-x:hidden`), which leaves a
  horizontal swipe or trackpad-scroll unclaimed — this claims it, stepping
  through the header's icon order. **Only "board" and "activity" are steps.**
  "settings" was a third step for one release, and it made every other swipe
  land back on the board with the sheet open, which looks identical to the
  board with it closed — read as the same view twice rather than a third
  destination. Settings stays the gear icon's job alone. A header with no
  `data-here` (the accents page, which carries no icon of its own) has no
  place in the order and opts out rather than guessing one. `.handle` and
  `input` are excluded from starting a swipe because both are draggable in
  their own right (the corner grip, the accents page's reorder handles, the
  font-size slider) — without the exclusion, dragging one past the threshold
  fires a page change out from under it.
- `src/board-state.mjs` — the board's address, remembered between runs
  (`~/.claude/streamdeck-board.json`, the daemon's **seventh** file and the
  second that is its own memory rather than a message to another process).
  The server used to take an ephemeral port and mint a fresh token every start,
  which is right for something you open from a key press and wrong for
  something you *scan onto an iPad*: the URL changed on every restart, so a
  bookmark broke and a page left open on the wall stayed grey. **Both halves
  have to persist** — a fixed port with a rotating token is still a dead
  bookmark, which is why the token is in here and not just the port.
  That makes this the one file in the project that is a **credential at rest**,
  so it is written `0600` and read back with both fields validated: the port
  reaches `listen()` and the token is compared against a query parameter, and
  a token that isn't a UUID this could have written is refused whatever the
  port beside it says. Validated per field rather than all-or-nothing, so a
  hand-edited port doesn't throw away a working token.
  **`DEFAULT_PORT` is 8765 and deliberately not 8080**: 8080 is the most
  standard alternative HTTP port and therefore the most likely to already be
  answering on a machine that runs dev servers — measured here, 8080 was in
  use along with 3000, 5000 and 8888, so it would have warned on every start.
  A clash is not fatal: `createConfigServer` falls back to an ephemeral port
  and returns a `warning` for `run()` to print above the QR (this module has no
  console of its own by design). **What it then remembers is the port to *try*,
  never the one it settled for** — the squatter is the thing that goes away,
  and the next run has to ask for the standard port again rather than chase an
  ephemeral number that meant nothing. `STREAMDECK_PORT` overrides.
  Ephemeral stays the default for anyone who doesn't pass `remember`, which is
  what stops `config-check` fighting a running daemon for the same socket.
  **One header on all three views**, exported from here (`iconHeader`,
  `HEADER_CSS`) and used by `config-server.mjs`'s two pages as well — it was
  icons on the board and text links on the config pages, which made "where am
  I and how do I get back" a different question depending on where you already
  were. Three icons: the board (the same nine keys the home-screen icon draws,
  so the way back looks like the thing it goes back to), activity, and
  settings — and **every one of them lands in the same place from every page,
  the gear included**. Settings are the board's sheet, so the gear toggles it
  on the board and links to `/board?…&settings=1` from anywhere else, which
  opens the board with the sheet already up and then drops the flag from the
  URL (the token has to stay — the poll reads `location.search` — but a reload
  must not keep reopening a sheet you closed). It pointed at the accents page
  from the config pages for one release, so the same icon landed you somewhere
  else depending on where you pressed it, which is the one thing a fixed icon
  bar exists to prevent. The accents page is deliberately *not* a fourth icon:
  it is where the deck's own config key lands and it keeps drag-to-reorder, so
  its header marks nothing current rather than marking something arbitrarily. The CSS travels with the markup because a header
  imported without the rules that make it one is how the two drift apart.
  **The sheet, the panel and the scrim all start below it** (`--head`), rather
  than covering the whole viewport as they did: with the header buried under
  the scrim there was no way to close the sheet with the control that opened
  it, and the activity icon was unreachable from a board with a panel up.
  **Saved to a home screen it runs standalone under `viewport-fit=cover`**, so
  the page owns the whole screen — status bar, notch and home indicator
  included — and the header sat under the clock. The four `env(safe-area-inset-*)`
  values fix that, and they are held as **variables** rather than used inline
  for a reason worth keeping: `env()` cannot be set from a console or a test,
  so a layout built directly on it is one nobody can drive, and this is exactly
  the sort of thing to get wrong twice. `--head` is `56px` plus the top inset,
  so everything already measuring from it follows; the grip, the grid and both
  overlays take the bottom and side ones. All four are 0 in a browser tab and
  on every other platform, so nothing else moves.
- `src/html.mjs` — `esc` and `colour`, in one place because two files now render
  markup and the alternative was an import cycle between them.
