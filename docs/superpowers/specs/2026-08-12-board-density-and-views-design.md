# Board Density and Views — Design

Date: 2026-08-12

## Problem

The board answers "which sessions exist and roughly what are they doing" and
stops there. Three gaps, in the order they bite:

1. **A state has no age.** `busy` looks the same after four seconds and after
   four hours, and `waiting` gives no way to rank two waiting sessions. The
   registry already records when the status last changed and nothing reads it.
2. **Nothing triages.** With eight keys lit, the two that want you look exactly
   as loud as the six that don't.
3. **A second press is mostly wasted.** It opens the nested-session overlay,
   which only exists for projects that happen to have worktree sessions. On
   every other key the press does nothing, and `3/7` is the most detail the
   board can give about a task list it has already fully parsed.

## Scope

- Time in current state, on every session key.
- An attention queue on a dedicated key.
- A per-session detail board on second press, replacing the nested overlay.
- Collapsing the view-mode state into one value as those land.

## Non-goals

- No new data sources. Everything here comes from files the daemon already
  reads: the session registry, the transcript tail scan, and
  `~/.claude/tasks/`. No git subprocess, no new network call.
- No writes. The read-only invariant holds; keys still only focus windows.
- No change to how sessions are matched, ordered, or grouped, beyond the slot
  count dropping from 14 to 13.

## 1. Time in current state

`getLiveSessions()` already returns `ts` (from `statusUpdatedAt`, falling back
to `updatedAt`) on every session, and no caller reads it. This is a render
change.

**Placement:** right-aligned in the accent bar, with the project caps re-fitted
to the width left over. The foot row is the obvious alternative but it only
exists when a session has task progress; making it permanent costs every key a
body line (4 → 3) and puts more of the aiTitle behind an ellipsis. The header
costs nothing.

**Format:** `45s` under a minute, `40m` under an hour, `2h14m` past it.

**Diffing:** `btn.drawn` must carry the *formatted* string, not `ts`. With the
raw timestamp every key re-encodes on every 2s poll; with the formatted string
a settled board redraws each key about once a minute.

## 2. Attention queue

**Key 13** (bottom row, second from right) is reserved for it. Key 14 stays the
usage readout. Session slots drop from 14 to 13.

**Resting state:** the count of sessions in `requires_action` or `waiting`,
over the word `WAITING`, over the longest current wait. Red, and pulsing on the
same `PULSE_MS` beat as a `requires_action` key. Dark and inert at zero — a
press then is a no-op, since there is nothing to show.

**The view:** the 13 session keys become the queue. `requires_action` first,
then `waiting`; within each group, longest-stuck first. Fewer sessions means
fewer body lines, so the type gets bigger. Pressing a session focuses its
window; pressing anything else returns to the board.

**Invariant note:** this is the one board that sorts by activity. That
contradicts "ordering is first-seen, never activity" on purpose — it is
transient triage, not a surface anyone builds muscle memory on. CLAUDE.md gets
a line saying so, so it doesn't read as a mistake later.

## 3. Session detail on second press

Second press on **any** session key opens it — the "was this the immediately
preceding press" rule already in `index.mjs` is unchanged, only what it opens.

**Header row** (5 keys): the full title across two keys, then state + time in
state, context %, and model + effort.

**Task keys:** one key per task, numbered, coloured by status — done, active,
todo. When there are more tasks than keys, the list is windowed around the
in-progress one rather than truncated from the top.

**Worktree tiles** take the tail slots before the usage key, so the nested
overlay's job survives inside the detail view. Tasks take what's left; extras
drop silently, as elsewhere on this board.

**Any press returns.**

**New data:** `model` and `effort`, both already on assistant lines in the
transcript tail that `readTranscriptSignals` scans — two more fields off the
same read, no second pass. The full task list is read from
`~/.claude/tasks/<session id>/` **only while the detail view is open**, so the
2s poll costs exactly what it costs today.

`refreshNested` and the `nestedView` mode are deleted.

## View state

`statsMode` (a boolean) and `nestedView` (an object) already share the job of
"which board is showing", and this adds two more modes. They collapse into one
`view` value — `{ kind: "sessions" | "attention" | "stats" | "detail", ... }` —
local to `run()` as both are today. A four-way boolean tangle is the version
that breaks.

Each view keeps its own `btn.drawn` signature prefix, as `stat ` and `nested `
do now, so switching modes redraws everything once and needs no explicit
invalidation.

## Checks

- `slots-check`: attention-queue ordering — `requires_action` ahead of
  `waiting`, longest-stuck first within each group, and a stable result when
  two sessions have the same age.
- `tasks-check`: the task-list window around the in-progress task — at the
  start of the list, at the end, and when the list is shorter than the window.
- `render-check`: one case per new key type — the attention key at zero and at
  a count, a task key in each of its three statuses, and a session key with
  time in state against a long project name (the caps re-fit is the part that
  can silently truncate).

## Risks

- **Header crowding.** The accent bar is 13px with 8px caps. `2h14m` beside a
  long project name may leave too little for either. `render-check` covers it;
  if it reads badly on the device, the fallback is the foot row at the cost of
  a body line.
- **Reserved key regret.** Key 13 is spent whether or not anything ever needs
  attention. With ~5 concurrent sessions there's room, but the ceiling drops to
  13 and extras still drop silently.
