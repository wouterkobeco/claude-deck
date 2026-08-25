# Rendering and the palette

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

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
  fifteen keys in five states. `colors-check` asserts the floors, so a hex
  nudged to taste can't quietly make one marker invisible on one key in one
  state — which is otherwise only findable by looking at that key, in that
  state, on the actual deck. Two floors there are deliberately lower than the
  rest and say so in comments: red markers (red is the darkest hue, and light
  enough to clear the others converges on the white idle square) and the gauge,
  which is checked against the dark track it's inset onto rather than the
  accent it would otherwise vanish into.
  **`idle_recent` is a fifth background and it is a colour, not a state.**
  A session idle for under `RECENT_IDLE_S` (5 min) draws deep purple rather
  than the idle grey: the first has something to read, the second is
  furniture. Nothing else knows about it — not `STATE_URGENCY`, the queues,
  the history log or the registry — because "which of two greys" is a
  rendering question and `idle` is still the state.
  **The hue is that 50 ΔE floor talking, not taste, and the obvious design
  was measured and rejected.** "Same colour, dimmer" cannot satisfy the
  state-separation floor at all: idle sits at L\* 36, so 50 ΔE of pure
  lightness lands at L\* −14. Every muted candidate was scored before a hex
  was chosen — blue-grey 800 (11 ΔE from idle), slate (22), steel (22),
  teal 900 (26) — and all four would have been two greys nobody could tell
  apart across a room, which is the exact failure this check exists to
  catch. `#4527a0` is the largest separation available (76) that collides
  with no other state's hue and can't read as the red key at a glance. Every
  other floor then passed by construction, because `colors-check` iterates
  `STATE_COLORS` rather than naming its members.
  **Two halves decide it, and they live apart on purpose.** `recentlyIdle`
  is the palette's half and stays pure here: idle, fresh `ts`, and neither
  `startedEmpty` nor `clearedEmpty`. Those two are exactly the flags
  `keyFields` lets blank a key's body, and that is not a coincidence — the
  same "nothing to say yet" that empties the text disqualifies the colour,
  and the two must not disagree on one key. Both are cases where `ts` is
  fresh and nothing happened: a session nobody has typed into dates its `ts`
  from the moment it registered, so without that exclusion opening a VS Code
  window lights a key for five minutes; and `/clear` is a turn like any
  other, so the session goes idle and restamps `ts` with nothing behind it,
  which would draw "there is something here to read" over the word CLEAR —
  the one thing that key is already saying there isn't. `stillUnread` in
  `index.mjs` is the half that needs the board's memory: pressing a key is
  what marks it read, since the colour means "this stopped and you haven't
  looked" and revealing the window answers exactly that. The mark is a
  **timestamp compared against the session's own `ts`**, never a boolean — a
  press from before the session went idle is a press about older news and
  must not suppress this one, and the same comparison is what makes a session
  that works again and stops again go purple a second time. `markSeen` sits
  beside every `focusWindow` call rather than inside it, because
  `focusWindow` gates its work on the window being VS Code's and "I have seen
  this" is true either way. `recent` is carried separately from `state` for
  the reason `shell` is: `state` is the block's, folded over subagents, and
  "did *this* just stop" is a question about the one session.
