# Nested (Worktree) Session Handling — Design

Date: 2026-08-11

## Problem

`getLiveSessions()` matches a session to a VS Code window by checking whether
the session's `cwd` sits *anywhere under* one of that window's workspace
folders (`isUnder` in `src/sessions.mjs`). A background worktree session
(e.g. `kob-backend/.worktrees/ai-code-detection`, spawned via
`isolation: 'worktree'` or the git-worktree skill) has a `cwd` nested inside
its parent project's folder, so it satisfies that check and gets folded into
the parent project's block as its own button — indistinguishable on the deck
from a real session with a live editor behind it. Pressing that button just
refocuses the parent window; there is no window for the worktree session
itself.

Confirmed live on this machine: `kob/kob-backend` has an open VS Code window
and a background session at `.worktrees/ai-code-detection`
(`f4950f00-6ebe-4944-9afc-1021476a5a93`, `kind: "interactive"`, own pid) that
currently occupies a phantom fourth button in the `kob-backend` block.
`kob-trace` has 13 such worktree directories under `.claude/worktrees/`; any
background session running in one produces the same effect. Separately
confirmed by direct test: in-process `Agent`-tool subagents do **not** create
a registry entry (spawned a 15s background subagent, polled
`~/.claude/sessions/*.json` throughout, no new file appeared) — this issue is
specific to session-level worktree processes, not the `Agent` tool.

No parent/launcher lineage exists anywhere in Claude Code's own state (checked
the registry JSON schema and a worktree session's transcript — `parentUuid`
there is message-threading within that session's own file, not a
cross-session link), so a nested session can be attributed to the *project
folder* it's nested under, never to a specific sibling session.

## Goals

- Nested sessions stop occupying their own board slot.
- The board still surfaces that they exist and how many, without a
  dedicated always-visible tile per one.
- A way to actually see them (title, state) on demand, without adding a
  permanent UI element.

## Non-goals

- No attempt to attribute a nested session to whichever sibling session
  launched it — established above as not derivable from any available data.
- No action available *on* a nested session from the deck (no window to
  focus, no separate affordance) — the overlay is read-only.
- No change to how genuinely separate real sessions in the same folder are
  shown (multiple Claude Code processes with `cwd` exactly equal to an open
  window's folder keep one button each, as today).

## Design

### 1. Session classification (`src/sessions.mjs`)

Replace the current folder match:

```js
const folder = folders.find((f) => isUnder(s.cwd, f));
if (!folder) continue;
```

with a stricter matcher that (a) prefers an exact match over an ancestor
match — a worktree opened as its own VS Code window is a real session, not a
nested one — and (b) among ancestor matches, prefers the most specific
(longest) folder path, fixing a latent bug where `.find()` picked whichever
open folder happened to come first in lock-file enumeration order:

```js
function matchFolder(cwd, folders) {
  if (folders.includes(cwd)) return { folder: cwd, nested: false };
  const ancestors = folders.filter((f) => isUnder(cwd, f));
  if (ancestors.length === 0) return null;
  const folder = ancestors.reduce((best, f) => (f.length > best.length ? f : best));
  return { folder, nested: true };
}
```

Each object `getLiveSessions()` returns gains `nested: boolean`. Nothing else
about the function's shape changes — it still returns a flat list of live
sessions, same as today; grouping stays `index.mjs`'s job, matching the
existing module boundary (`sessions.mjs` describes sessions, `index.mjs`
does slotting).

### 2. Board layout & interaction (`src/index.mjs`)

- `assignSlots` filters to `sessions.filter((s) => !s.nested)` before its
  existing folder/session ordering logic. Nested sessions never claim a slot.
- In `refresh()`, for the earliest-arrived (`sessionOrder`) real session
  button in each folder's block, compute that folder's nested sessions from
  the full (unfiltered) session list and store them as `btn.nestedSessions`.
  Every other button in the block gets `[]`.
- Press handling adds a third view alongside `sessions` and the existing
  `statsMode`: a per-folder **nested overlay**.
  - Track the last press as `{ index, session_id | null }`, updated
    unconditionally on *every* physical key-down — session buttons, the
    usage key, and presses ignored while `statsMode` is on — not just ones
    that result in a focus action. This is what makes "press it again" mean
    literally the next key-down on the same button: anything else pressed
    in between (checking stats, pressing a different project) breaks the
    chain, same as a real double-press gesture would expect.
  - Pressing a primary button (one with `nestedSessions.length > 0`) whose
    immediately preceding press was that same `{index, session_id}` pair
    opens the overlay for its folder instead of refocusing. Any other press
    on it — first press ever, a different key pressed in between, or the
    session at that slot changed since the last press — focuses VS Code as
    today and records the press.
  - While the overlay is showing, pressing *any* key (including the usage
    key) exits back to the normal board. The overlay has no in-place
    actions.
  - `pulse()` (the `requires_action` flasher) treats "overlay active" the
    same way it already treats `statsMode`: suspended while it's showing, so
    it doesn't redraw over it or read stale `renderParams`. The main poll
    loop does *not* suspend for the overlay the way it does for `statsMode`
    — see below, it keeps refreshing the overlay's own content.

**Overlay refresh:** while showing, the overlay redraws on the same 2s poll
as the main board, from a fresh `getLiveSessions()` call each tick, rather
than a static snapshot taken at open time — a nested session's state or
title can change while you're looking. Tile *positions* are fixed for the
duration of the visit: order is captured once, at the moment the overlay
opens (first-seen, same rule as the main board's `folderOrder`), and never
re-sorted while it's showing. A nested session that finishes mid-visit goes
blank in its slot rather than causing the remaining tiles to shift — you're
mid-glance at a specific tile, and re-flowing everyone else around it would
be more disruptive than one gap.

### 3. Rendering (`src/render.mjs`)

- `renderKey` gains a left-margin column of 2×2px squares, one per nested
  session, starting just below the context-gauge line (`titleHeight`) and
  stacking downward with a small gap. If more squares would fit vertically
  than the column has room for, the last visible square flashes instead of
  being silently dropped — reusing the existing pulse tick (`bright` in
  `index.mjs`'s `pulse()`), extended to also redraw buttons carrying an
  overflow marker, not just `requires_action` ones.
- Whenever `nestedCount > 0`, the margin column's width is reserved out of
  the label text's layout, not just visually overlaid on top of it: the
  width passed into `wrapLabel` for that button's body text is
  `width - marginWidth` instead of the full key `width`, so wrapped lines
  stay clear of the square column instead of centering across the whole key
  and potentially running through it. `fitCaps` and the caps row are
  unaffected — the squares start below the title bar, so there's no overlap
  to guard there.
- The overlay reuses `renderKey` unchanged for each nested session's tile —
  same label/state/progress rendering as a normal button — except the
  "project" caps show the nested folder's own basename (e.g.
  `AI-CODE-DETECTION`) rather than repeating the parent project's name, so
  tiles within one overlay are distinguishable from each other. Same accent
  color as the parent project, so the overlay still visually reads as
  belonging to it.

## Known limitation (accepted)

If a project's VS Code window has *zero* real sessions but does have nested
ones, there is no primary button left to carry the indicator, and those
nested sessions won't surface on the deck at all — no regression from today
(there was never a useful action to take on them either way), just silent
instead of phantom.

## Testing

- `slots-check`: cases for `matchFolder` — exact match wins over ancestor
  match; most-specific ancestor wins among multiple; a session with no
  matching folder at all is still dropped.
- `render-check`: cases for the nested-count square column at a few counts
  (zero, a few, more than fit), for the overlay tile's caps using the
  nested folder's basename instead of the project name, and for a long
  label on a button with `nestedCount > 0` wrapping inside the margin
  instead of centering across the full key width.
