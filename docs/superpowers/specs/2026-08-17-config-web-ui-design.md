# Config web UI — design

Date: 2026-08-17
Status: approved, not yet implemented
Roadmap item: `docs/roadmap.md` item 2 ("web ui, in our code, started with
button in stream deck ... First thing is way to change the header colors of
the projects")

Depends on: persisted accents (`src/accents.mjs`), roadmap item 1, already
implemented.

## What this is

A local web page, served by the daemon itself, reached from a key on the
Stream Deck, that lets you set which accent colour each project on the board
wears. It is the first of what the roadmap calls "config stuff"; ordering the
board by hand (drag-to-reorder) is wanted later and is explicitly designed
*for* here without being built.

## What it is not

- Not a settings file. `~/.claude/streamdeck-accents.json` stays what
  `accents.mjs` made it: the daemon's own memory, safe to delete.
- Not a colour picker. The palette is the existing eight `ACCENTS` and nothing
  else — see "Palette is a closed set" below.
- Not reachable from off this machine, and not reachable from this machine
  without the token the daemon just handed the browser.
- Not live. The deck sitting next to you is the live view.

## Decisions and why

### Palette is a closed set

The UI offers exactly the eight existing accents as swatches. Arbitrary hex —
validated or not — was rejected.

`colors-check` asserts that every accent clears a 4.0:1 contrast floor against
the dark caps text drawn on it, sits at least 30 ΔE from every other accent
*and* from every state background, and stays in the light tier above every
state colour. Those are the reasons a 72px key is readable across a room in
four different states. A free colour picker either makes those guarantees
false in one click, or forces the check's logic out of `scripts/` and into
`src/` so the server can re-run it — and then hands you a colour wheel that
says no. Eight swatches makes the whole question disappear.

The cost is real and accepted: with eight colours and eight or more live
projects, giving one project a colour necessarily takes it from another.

### Collision is resolved by swapping

Picking a colour another **live** project wears trades the two colours.

The alternative — bumping the other project to a free accent — needs the file
to record which picks were made by hand, so that the next poll's collision
rule doesn't undo them; and with eight live projects there is no free accent,
so it degrades to a swap anyway. Greying out taken swatches was rejected for
the opposite reason: with eight live projects every swatch is grey and you can
change nothing, which is precisely when you most want to.

Swapping has a property the others don't: it maintains the invariant "no two
live folders share an accent" *by construction*. The collision rule added in
roadmap item 1 (first folder processed keeps it, the later one re-claims)
therefore never fires on a manual pick, and no "chosen by hand" flag is needed
anywhere in the file or the map.

**That claim only holds if the closed projects are handled too**, and the
naive version doesn't. If a live project takes a colour that a
remembered-but-closed project also holds, the duplicate survives in the file;
when the closed project reopens, item 1's collision rule fires and picks a
winner by iteration order over the session list — effectively `readdir` order,
which means nothing. Half the time that silently takes back the colour you
deliberately assigned, days later, with nothing on the deck to explain it.
Item 1's rule was designed for two *remembered* claims that never saw each
other, where an arbitrary winner is fine; a deliberate human choice is not that
case.

So the swap does two things, not one: it trades with a **live** owner, and it
**deletes** the entry of any closed owner holding that colour. The closed
project re-claims on return like any new arrival, the duplicate never exists,
and the by-construction claim above is true rather than nearly true. Still no
flag — the file records no more than it did.

### The page is server-rendered HTML with form POSTs

Rejected: a JSON API with client-side rendering.

The general argument for the API — it survives a UI rewrite — assumes the UI
grows into something interactive. Everything plausibly on this config list
(accent per project, pin a project to a slot, hide one, toggle a remote host)
is a small set of discrete values edited rarely by one person, with a physical
device as the output. That is form-shaped.

The decisive factor is this repo's quality model. Every non-trivial module in
`src/` has a plain `node scripts/*-check.mjs` that imports it and asserts. A
form POST handler is the most checkable code available: start the server on
port 0, `fetch` it, assert. Client JS inside a template literal is the least —
nothing here can lint it, import it, or execute it. The API version would put
this feature's real logic in the one untestable place in the repository.

**Drag-to-reorder is wanted "at some point" and does not change this.** It is
mostly a data change: it sets `folderOrder` (`index.mjs`), the append-only
first-seen map, which is not persisted today and would need the same treatment
`accents.mjs` gave the accent map. That work is independent of how the page is
built. Note it does not violate the ordering invariant — `CLAUDE.md` forbids
re-sorting by *activity*, because that breaks muscle memory for where a button
is; deliberately choosing an order serves it.

What drag does cost: when it lands, the page renderer is rewritten (~40 lines)
and colour picking moves onto the same fetch-based flow **in that same pass**,
so the page never runs two paradigms at once. That rewrite is the accepted
price of shipping colours sooner and fully checked. The dependency boundary
below is what keeps the price at one function.

### The server is started by a press and kept for the daemon's life

No idle shutdown: that is a timer to get wrong, and the port does not exist
until you have asked for it. A second press reopens the browser at the same
URL.

### Token, not open localhost

Loopback binding stops anything off this machine. The token stops any other
local process, and any web page you happen to have open, from POSTing to it.
Blast radius today is genuinely "a key changes colour", but this is the door
the rest of "config stuff" walks through later, and the token is three lines.

## Architecture

```
stats board, key 11 ──press──► openConfig()
                                   │
                                   ├─ createConfigServer(deps) — once
                                   │     listen(0, "127.0.0.1"), randomUUID token
                                   └─ open http://127.0.0.1:<port>/?t=<token>

browser ── GET /?t= ──►  page (one form per live project, 8 swatch buttons)
        ── POST /accent?t= ──►  validate ─► deps.setAccent(key, accent) ─► 303 /?t=
                                                   │
                                            index.mjs: swap + persistAccents()
                                                   │
                                            next 2s poll redraws the key
```

### Modules

**`src/accents.mjs`** (exists) gains two things, becoming the accent palette,
its rules, and its persistence:

- `ACCENTS`, moved from `index.mjs`. `index.mjs` re-exports it, leaving
  `colors-check` and `slots-check` imports untouched, and `config-server.mjs`
  can import the palette without a cycle back into the daemon (`index.mjs`
  imports `config-server.mjs` for `openConfig`, so the reverse edge would be
  one).
- `applyAccentChoice(accents, liveKeys, folder, accent)` — the pure swap, see
  The swap below. It lives here rather than in `index.mjs` so a check can call
  it without reaching a persist that writes the real file.

**`src/config-server.mjs`** (new). Exports:

- `createConfigServer(deps)` → `{ server, url }`. Does not open a browser.
  This is what `config-check` drives.
- `openConfig(deps)` → starts the server on first call, reuses it after, and
  opens the browser. Best-effort: any failure logs the URL and changes
  nothing.

`deps` is the entire coupling to the daemon:

- `projects()` → `[{ key, name, host, accent }]` for every folder with a live
  session, in `folderOrder` order — including any past the 13-slot cap, per
  "all live folders, not the visible 13" under The swap. `name` is the folder's
  basename, the same string the key's caps bar shows, per `CLAUDE.md`'s "a
  key's caps bar is always the project name". `key` is `folderKeyFor`'s value
  and is what a POST sends back.
- `setAccent(key, accent)` → performs the swap and persists.

**`src/render.mjs`**: `renderBack({ width, height, glyph = "←", caps = "BACK" })`.
The defaults leave every existing call identical; the config key is
`{ glyph: "⚙", caps: "CONFIG" }`. No new render function.

**`src/index.mjs`**: the config tile on the stats board, the press branch,
`liveProjects`, `setAccent`, and the `deps` object.

### The key

Index **11** on the stats board — `refreshStats` builds 10 tiles (2 reset + 7
stats + 1 version) and puts the back key at `DETAIL_BACK_INDEX` (10), leaving
11 and 12 blank. 11 sits beside the back key, making a controls cluster on the
bottom-left row.

Assigned by index, never spliced, for the same reason the back key is: an
unreadable stats cache makes the tile list short, and the way in must not
move.

Pressing it opens the browser **and returns the deck to the sessions board**,
so the accents change on the real keys while you pick. That is the only place
the choice actually reads.

### Routes

| Request | Response |
|---|---|
| `GET /?t=<token>` | 200, the page |
| `POST /accent?t=<token>` | 303 to `/?t=<token>` on success, 400 on invalid input |
| any request with a missing or wrong token | 403 |
| any other path | 404 |

The token is checked **before** routing, so an unknown path without a token
answers 403 rather than confirming the path is unknown. It is one
`randomUUID()` per server, compared with `!==`. Deliberately not
`timingSafeEqual`: it is a 122-bit random value on loopback, and anything else
would be theatre.

A 400 is a dead end — a bare status, no way back. That is deliberate rather
than unfinished: it is only reachable from a page left open until its project
closed, or from a forged request, and the way back in both cases is the config
key. Spending a friendly error page on those two cases is not worth the code.

Every response carries `Referrer-Policy: no-referrer`. The page has no external
links today, so nothing leaks today — but the token is in the URL, and the day
someone adds a link it would travel in the `Referer`. One header is cheaper
than remembering the constraint.

Accepted and stated rather than mitigated: the token lives for the daemon's
lifetime and the tokened URL sits in browser history after one visit. That is
the same trade the project already makes with the world-writable `/tmp` scratch
tree — it holds under this project's single-user macOS model and would need
revisiting on a shared machine.

### Request validation

This is the trust boundary and is not simplified:

- `accent` must be **string-identical to one of the eight**, not merely
  hex-shaped. The palette is a closed set and `colors-check`'s guarantees
  cover only those eight values.
- `folder` must be a key `projects()` currently returns. A page left open
  overnight cannot write a colour for a project that has gone, and nothing
  arbitrary ever enters `folderAccent`.
- Request body capped at 4KB.

### The page

Dark, matching the deck. One row per live project:

- the project name drawn **on its current accent in the accent bar's own dark
  caps**, so the row shows what the key actually looks like rather than an
  abstract swatch;
- the full folder key (`host:/path` for remote) small underneath;
- eight swatch submit buttons, the current one marked.

Each row is its own `<form method="post" action="/accent?t=…">` with a hidden
`folder` field; each swatch is `<button name="accent" value="#…">`.

Everything interpolated goes through an `esc()` helper. Folder keys come from
the filesystem and, for remote projects, **from another machine's registry** —
the same class of untrusted input `CLAUDE.md` already flags where remote ids
reach a path. `<script>` is a legal directory name.

`esc()` does the full five-entity escape (`& < > " '`), not tags only. The
hidden `folder` field puts these strings in **attribute** context, where a
`"` breaks out without any `<` involved — and a tag-only escaper would pass the
`<script>` check case while still being injectable.

An empty board renders "nothing on the board right now", not an empty page.

### The swap

The mutation is **pure and lives in `accents.mjs`**; persistence is a wrapper
in `index.mjs`. That split is not tidiness — it is forced by the same guard
`persistAccents` already carries (`index.mjs`: "Written from here rather than
from assignSlots, which is exported and called by slots-check — a check that
assigned an accent would write this machine's real file"). A `setAccent` that
both swapped and persisted, exported for `slots-check` to test, would clobber
the user's real `~/.claude/streamdeck-accents.json` with fixture folders on
every check run. `setAccent` was going to be exactly that. This is CLAUDE.md's
"a guard that encodes 'X is impossible' is deleted in the commit that makes X
possible" rule landing again: the guard's precondition was "the only mutator a
check can reach is `assignSlots`", and this change removes it.

```js
// accents.mjs — pure, exported, what slots-check drives
export function applyAccentChoice(accents, liveKeys, folder, accent) {
  const previous = accents.get(folder);
  for (const [f, c] of accents) {
    if (f === folder || c !== accent) continue;
    if (liveKeys.has(f)) { if (previous) accents.set(f, previous); }
    else accents.delete(f);           // a closed owner: drop it, don't duplicate
  }
  accents.set(folder, accent);
}

// index.mjs — the untested two-line wrapper
const setAccent = (folder, accent) => {
  applyAccentChoice(folderAccent, liveProjectKeys(), folder, accent);
  persistAccents();
};
```

`liveProjects` is a module-level `Map` of folder key → `{ folder, host, name }`,
rebuilt in **`liveSessions()`**, not in `assignSlots`. `assignSlots` runs only
from `refresh()`, i.e. only on sessions-board polls — so a page left open while
you toggle to the stats or detail board would be picking against a frozen set,
and a project that appeared since would be invisible to the owner search,
minting exactly the live–live duplicate the swap exists to prevent.
`liveSessions()` is called by every branch of the poll loop, which is the
property needed.

The set is **all live folders, not the visible 13**. A project past the slot
cap has no key yet, but it will, and it must not be invisible to the owner
search — CLAUDE.md already takes this position for `attentionQueue`, which is
"passed the whole session list, not the visible one". `projects()` renders the
same set for the same reason.

Nothing redraws explicitly: `accent` is already part of `refresh`'s drawn
signature, so the next poll picks the change up within 2s. `persistAccents()`
runs immediately rather than waiting for that poll, so a pick survives a
daemon killed a second later; its change-detection snapshot handles the extra
call site correctly, since the manual pick updates `lastAccentsWritten` and the
next poll's call then no-ops.

There is no poll-versus-HTTP race to guard against. `applyAccentChoice`,
`persistAccents` and `assignSlots` are all synchronous, and Node interleaves
only at `await` boundaries, so nothing can observe the map mid-mutation. The
worst case is a POST landing between `refresh()`'s `assignSlots` and its
per-button renders: a few keys draw the pre-swap accent for one poll and the
signature diff repaints them on the next. `pulse()` can likewise redraw a
flashing key from cached `renderParams` with the old accent for up to 2s.
Both are transient and neither needs code.

## Testing

**`scripts/config-check.mjs`** (new) — a real server on port 0, real `fetch`,
fake deps, no deck and no `~/.claude`:

- no token → 403
- wrong token → 403
- unknown path → 404
- the page contains every project and eight swatches
- an accent outside the palette → 400, nothing mutated
- a folder not currently live → 400, nothing mutated
- a valid POST → 303, `setAccent` called with the right arguments
- a project named `<script>` comes back escaped

**`scripts/slots-check.mjs`** (existing, already owns accent behaviour) drives
the pure `applyAccentChoice` against its own `Map` — never `setAccent`, which
writes the real file:

- a swap trades both ways
- picking a free colour changes nobody else
- picking a colour held only by a remembered-but-closed folder **drops that
  folder's entry**, so the duplicate never reaches the file
- the pick survives the next `assignSlots` — i.e. the collision rule does not
  take it back

**`scripts/render-check.mjs`** (existing): the config key's glyph and caps,
alongside the existing back-key case. It must **assert ink in the glyph area**,
not merely render without error: `⚙` (U+2699) has to survive sharp/librsvg and
the resolved font, which is exactly the class of assumption this project checks
off the raster rather than trusting (see `CHAR_WIDTH`). If the glyph is missing
from Helvetica, fall back to a drawn shape or different caps — the check is
what tells us.

`npm run config-check` added to `package.json`.

## Documentation

- `CLAUDE.md`: a `config-server.mjs` module entry; `ACCENTS` moving into
  `accents.mjs`; the commands list; and a note under the read-only invariant
  that the daemon now opens a loopback port on request — it remains true that
  it writes only its three files.
- `README.md`: how to reach the page and what it does.

### Guard comments this change invalidates

CLAUDE.md's rule — "a guard that encodes 'X is impossible' is deleted in the
commit that makes X possible" — applies to three existing comments whose
preconditions this change removes. They are amended in the same commit, not
later:

- `index.mjs`, the stats-board press branch: *"Stat tiles aren't clickable; the
  back key is."* The config key makes a second stats tile clickable.
- `index.mjs`, `persistAccents`'s header: *"Only on change, which in practice
  means the poll a new project first appears on."* It is now also every manual
  pick — and the "written from here rather than from assignSlots" rationale
  gains the second, sharper reason spelled out under The swap above.
- `index.mjs`'s collision comment and its twin in `slots-check.mjs`: *"Two
  folders can arrive remembering the same colour: they were never live at the
  same time, so neither claim ever saw the other."* With the closed-owner
  delete above, a manual pick still cannot create that state — but the comment
  should say that is now enforced by `applyAccentChoice` rather than merely
  being the only way it could arise.

## Out of scope

- Drag-to-reorder, and persisting `folderOrder` — a later item, designed for
  above but not built.
- Any config beyond accents.
- Listing remembered-but-closed projects. The page shows what is on the board.
- Live-updating the page.
