# Nested (Worktree) Session Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop background worktree sessions from occupying phantom buttons in their parent project's block on the deck; surface them instead as a small indicator on the project's first button, with a full on-demand overlay reachable by pressing that button twice in a row.

**Architecture:** `sessions.mjs` classifies each live session as real or `nested` via a stricter folder matcher. `index.mjs`'s `assignSlots` excludes `nested` sessions from the board and hands each project's first (earliest-arrived) button its folder's nested sessions through a new `nestedBySlot` out-param. `render.mjs`'s `renderKey` draws a small indicator-square column for that count, reserving its width out of the label's wrap layout. `index.mjs` adds a global last-press tracker and a per-folder overlay view, reusing `renderKey` and the existing blank/diffing conventions for the overlay's own poll-driven refresh.

**Tech Stack:** Plain Node.js (`.mjs`, no framework), `sharp` for SVG→raster, `@elgato-stream-deck/node` for the device. Tests are runnable scripts under `scripts/`, no test runner.

## Global Constraints

- No test framework — every check is a plain `node scripts/*-check.mjs` that `process.exit(1)` on mismatch, run directly (per `CLAUDE.md`).
- Follow the existing `btn.drawn` diffing convention: any new visual input (here, `nestedCount`) must be folded into the signature string a button's redraw is gated on, or changes won't appear until something else changes.
- Follow the existing first-seen ordering invariant: nothing in this feature re-sorts an already-settled board or overlay by activity.
- macOS/MK.2-only, 72×72 keys, 15 keys total — unchanged by this feature.

---

## Task 1: Session classification (`src/sessions.mjs`)

**Files:**
- Modify: `src/sessions.mjs:247-256` (folder matching inside `getLiveSessions`)
- Test: `scripts/slots-check.mjs` (new cases, appended)

**Interfaces:**
- Produces: `matchFolder(cwd: string, folders: string[]): { folder: string, nested: boolean } | null`, exported from `src/sessions.mjs`.
- Produces: every session object `getLiveSessions()` returns now includes `nested: boolean` alongside its existing `folder` field.
- Consumes: nothing new — `isUnder` (already in `src/sessions.mjs:32-34`) is reused unchanged.

- [ ] **Step 1: Write the failing test**

Add to `scripts/slots-check.mjs`, right after the existing `eq` helper definition and before the existing `const A = "/projects/alpha";` line:

```js
import { matchFolder } from "../src/sessions.mjs";

// matchFolder: an exact match beats being nested under another open folder —
// a worktree opened as its own VS Code window is a real session, not nested.
eq(matchFolder("/proj/sub", ["/proj", "/proj/sub"]), { folder: "/proj/sub", nested: false }, "exact match wins");

// Among ancestor-only matches, the most specific (longest) folder wins —
// fixes the old .find()'s arbitrary first-match behavior.
eq(
  matchFolder("/proj/sub/deep", ["/proj", "/proj/sub"]),
  { folder: "/proj/sub", nested: true },
  "most specific ancestor wins"
);

// No open folder contains this cwd at all.
eq(matchFolder("/elsewhere", ["/proj"]), null, "no match");

// A trailing slash on cwd (never seen from Claude Code's own registry, but
// cheap to guard) must still resolve as an exact match, not fall through to
// a spurious "nested under itself" ancestor match.
eq(matchFolder("/proj/", ["/proj"]), { folder: "/proj", nested: false }, "trailing slash still matches exactly");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run slots-check`
Expected: fails with an import error (`matchFolder` is not exported from `src/sessions.mjs` yet).

- [ ] **Step 3: Implement `matchFolder` and use it in `getLiveSessions`**

In `src/sessions.mjs`, add this function near `isUnder` (after its definition, around line 34):

```js
/**
 * Matches a session's cwd to the open VS Code window it belongs to. An exact
 * match always wins over an ancestor match — a worktree opened as its own
 * window is a real session, not a nested one. Among ancestor-only matches,
 * the most specific (longest) folder wins, so a session nested several
 * levels deep attaches to its closest open ancestor rather than whichever
 * folder happened to come first in lock-file order.
 */
export function matchFolder(cwd, folders) {
  // isUnder already tolerates a trailing slash on `folder`; strip one from
  // `cwd` too so an incidental trailing slash there can't make an exact
  // match miss and fall through to being misclassified as nested.
  const target = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (folders.includes(target)) return { folder: target, nested: false };
  const ancestors = folders.filter((f) => isUnder(target, f));
  if (ancestors.length === 0) return null;
  const folder = ancestors.reduce((best, f) => (f.length > best.length ? f : best));
  return { folder, nested: true };
}
```

Then replace lines 247-252 of `getLiveSessions` (currently):

```js
    const folder = folders.find((f) => isUnder(s.cwd, f));
    if (!folder) continue; // no live local VS Code window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder,
```

with:

```js
    const match = matchFolder(s.cwd, folders);
    if (!match) continue; // no live local VS Code window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder: match.folder,
      nested: match.nested,
```

(the remaining fields — `name`, `state`, `ts` — stay exactly as they are on the following lines).

Also update the doc comment above `getLiveSessions` (currently ending "...without this a session that just asked you for a permission rule reads on the deck as no different from one that's simply caught up.") by appending one sentence:

```
 * A session whose cwd is nested inside — but not equal to — the matched
 * window's folder (a background worktree checkout) is flagged `nested:
 * true`; index.mjs keeps those off the board's own slots.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run slots-check`
Expected: `OK: project grouping` (the new `matchFolder` assertions pass silently — `eq` only prints on failure).

- [ ] **Step 5: Commit**

```bash
git add src/sessions.mjs scripts/slots-check.mjs
git commit -m "feat: classify sessions nested under (not equal to) a window's folder"
```

---

## Task 2: Nested-aware slot assignment (`src/index.mjs`)

**Files:**
- Modify: `src/index.mjs:30-32` (module-level order maps) and `src/index.mjs:107-128` (`assignSlots`)
- Test: `scripts/slots-check.mjs` (new cases, appended)

**Interfaces:**
- Consumes: `s.nested` from Task 1's session shape.
- Produces: `assignSlots(sessions, slots, nestedBySlot = [])` — `nestedBySlot` is filled in place, same length as `slots`. `nestedBySlot[i]` is `null` for any slot that isn't the first button of its project's block, and the array of that folder's nested sessions (possibly empty, ordered first-seen) for the slot that is.

- [ ] **Step 1: Write the failing test**

In `scripts/slots-check.mjs`, change the `s` helper to accept an optional third argument (existing calls are unaffected — `nested` defaults to `false`, same as today's implicit `undefined`):

```js
const s = (id, folder, nested = false) => ({ session_id: id, folder, nested });
```

Then append, after the existing "full board drops extras" case and before `console.log("OK: project grouping");`:

```js
// A nested (worktree) session never claims its own slot, and attaches to
// the first (earliest-arrived) real session's button in its folder's block.
const nestedBySlot = new Array(5).fill(null);
assignSlots([s("a1", A), s("a2", A), s("w1", A, true), s("b1", B)], slots, nestedBySlot);
eq(slots, ["a1", "a2", "b1", null, null], "nested session claims no slot");
eq(nestedBySlot[0], [{ session_id: "w1", folder: A, nested: true }], "nested session attaches to the block's first button");
eq(nestedBySlot[1], null, "sibling real session in the same block gets no nested list");
eq(nestedBySlot[2], null, "unrelated project's button gets no nested list");

// A folder with no nested sessions at all: its primary button gets an empty
// list, not null — callers can treat "primary button" and "has a list" the
// same way without a null check.
const nestedBySlot2 = new Array(5).fill(null);
assignSlots([s("a1", A)], slots, nestedBySlot2);
eq(nestedBySlot2[0], [], "primary button with no nested sessions gets an empty list");

// Nested sessions keep first-seen order too, same as real sessions and
// folders do (CLAUDE.md: "ordering is first-seen, never activity") —
// independent of whatever order a given getLiveSessions() poll reports them
// in.
const nestedBySlot3 = new Array(5).fill(null);
assignSlots([s("a1", A), s("w1", A, true), s("w2", A, true)], slots, nestedBySlot3);
eq(nestedBySlot3[0].map((n) => n.session_id), ["w1", "w2"], "nested sessions ordered first-seen");
assignSlots([s("a1", A), s("w2", A, true), s("w1", A, true)], slots, nestedBySlot3);
eq(
  nestedBySlot3[0].map((n) => n.session_id),
  ["w1", "w2"],
  "nested session order survives being reported in a different order"
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run slots-check`
Expected: fails — with today's 2-argument `assignSlots(sessions, slots)`, the extra `nestedBySlot` argument is simply ignored, so it's never written and still holds its initial `fill(null)` value. `nestedBySlot[0]` stays `null`, and `eq` reports a mismatch against the expected array.

- [ ] **Step 3: Implement**

First, in `src/index.mjs`, find the module-level order maps (currently around line 30):

```js
const folderOrder = new Map();
const sessionOrder = new Map();
let arrivals = 0;
```

and add a third map for nested-session arrival order:

```js
const folderOrder = new Map();
const sessionOrder = new Map();
const nestedOrder = new Map();
let arrivals = 0;
```

Then replace `src/index.mjs:107-128` (the whole current `assignSlots` function) with:

```js
export function assignSlots(sessions, slots, nestedBySlot = []) {
  const real = sessions.filter((s) => !s.nested);
  const nested = sessions.filter((s) => s.nested);

  for (const s of real) {
    if (!folderOrder.has(s.folder)) folderOrder.set(s.folder, folderOrder.size);
    if (!sessionOrder.has(s.session_id)) sessionOrder.set(s.session_id, arrivals++);
  }
  for (const s of nested) {
    if (!nestedOrder.has(s.session_id)) nestedOrder.set(s.session_id, arrivals++);
  }

  const live = new Set(real.map((s) => s.session_id));
  for (const id of [...sessionOrder.keys()]) {
    if (!live.has(id)) sessionOrder.delete(id);
  }
  const liveNested = new Set(nested.map((s) => s.session_id));
  for (const id of [...nestedOrder.keys()]) {
    if (!liveNested.has(id)) nestedOrder.delete(id);
  }

  const ordered = [...real].sort(
    (a, b) =>
      folderOrder.get(a.folder) - folderOrder.get(b.folder) ||
      sessionOrder.get(a.session_id) - sessionOrder.get(b.session_id)
  );

  slots.fill(null);
  nestedBySlot.length = slots.length;
  nestedBySlot.fill(null);

  const visible = ordered.slice(0, slots.length);
  visible.forEach((s, i) => {
    slots[i] = s.session_id;
    // Only the first button of a project's contiguous block carries its
    // nested (worktree) sessions, so the indicator and double-press trigger
    // show in exactly one place per project. Nested sessions are sorted by
    // their own first-seen order (nestedOrder), not whatever order this
    // particular poll happened to report them in.
    const isPrimary = i === 0 || visible[i - 1].folder !== s.folder;
    if (isPrimary) {
      nestedBySlot[i] = nested
        .filter((n) => n.folder === s.folder)
        .sort((a, b) => nestedOrder.get(a.session_id) - nestedOrder.get(b.session_id));
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run slots-check`
Expected: `OK: project grouping`

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs scripts/slots-check.mjs
git commit -m "feat: exclude nested sessions from board slots, group them by folder"
```

---

## Task 3: Indicator squares and margin-reserved label wrapping (`src/render.mjs`)

**Files:**
- Modify: `src/render.mjs:50-139` (`renderKey`)
- Test: `scripts/render-check.mjs` (new cases, appended)

**Interfaces:**
- Consumes: nothing new from other tasks — pure rendering change.
- Produces: `renderKey({ ..., nestedCount })` — new optional param (default falsy/0, fully backward compatible with every existing caller). When `nestedCount > 0`, the returned image includes a left-margin square column and the body label wraps inside the remaining width instead of the full key width.

- [ ] **Step 1: Write the failing test**

Append to `scripts/render-check.mjs` (after the existing single render/assert/write block, before end of file):

```js
// Nested-session indicator: a count that fits inside the column, and one
// large enough to force the overflow-flash square.
for (const [name, nestedCount] of [
  ["small", 4],
  ["overflow", 25],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "kob-backend",
    accent: "#4fc3f7",
    project: "kob-backend",
    nestedCount,
  });
  if (buf.length !== expected) {
    console.error(`FAILED (nested ${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-nested-${name}.png`, import.meta.url).pathname);
}

// Overlay tile: caps show the worktree folder's own basename, not the
// parent project's name — same renderKey call an overlay tile makes.
const overlayBuf = await renderKey({
  width,
  height,
  state: "idle",
  label: "review transcript signals",
  accent: "#4fc3f7",
  project: "ai-code-detection",
});
if (overlayBuf.length !== expected) {
  console.error(`FAILED (overlay tile): expected ${expected} bytes, got ${overlayBuf.length}`);
  process.exit(1);
}
await sharp(overlayBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-overlay.png", import.meta.url).pathname);

// A long label plus nested squares together: the label must wrap inside the
// reserved margin instead of centering across the full key width.
const marginBuf = await renderKey({
  width,
  height,
  state: "busy",
  label: "a very long aiTitle that would otherwise span the full key width",
  accent: "#4fc3f7",
  project: "kob-backend",
  nestedCount: 6,
});
if (marginBuf.length !== expected) {
  console.error(`FAILED (label margin): expected ${expected} bytes, got ${marginBuf.length}`);
  process.exit(1);
}
await sharp(marginBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-margin.png", import.meta.url).pathname);

console.log("OK: nested indicator, overlay tile, margin-reserved wrapping");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run render-check`
Expected: runs without a byte-length failure (the extra `nestedCount` param is simply ignored by today's `renderKey`), but produces no visible square column — this step is a smoke check that the harness runs; the real verification for this task is visual (Step 4).

- [ ] **Step 3: Implement**

Replace `src/render.mjs:50-139` (the whole current `renderKey` function) with:

```js
/** Renders a solid-color key with a centered, word-wrapped label. Returns a raw RGBA buffer. */
export async function renderKey({ width, height, state, label, accent, project, progress, context, pulse, nestedCount }) {
  // requires_action is the one state worth flashing — it's the only one
  // that's actually blocked on you, so it's the only one that should chase
  // your eye across the room.
  const color = pulse && state === "requires_action" ? "#ff5252" : STATE_COLORS[state] ?? STATE_COLORS.idle;
  const capSize = Math.round(height * 0.11);
  // Accents are all light, so the caps go dark rather than white.
  const caps = project ? fitCaps(project, width, capSize) : "";
  // Title zone: 3px of plain accent-coloured pad, an 8px row for the caps
  // text, a 2px dark border on the bottom edge only — 13px fixed, not derived
  // from capSize. The gauge, when known, eats that border rather than adding
  // its own height.
  const titleTopPad = 1;
  const titleBorder = 2;
  const titleTextRow = 8;
  const titleHeight = project
    ? titleTopPad + titleBorder + titleTextRow + titleBorder
    : Math.round(height * 0.12);
  const barHeight = accent ? titleHeight : 0;
  const fontSize = Math.round(height * 0.19);
  // Tighter than typographic ideal so four lines still fit under the bar.
  const lineHeight = fontSize * 1.05;
  const progressSize = Math.round(height * 0.19);
  // The count needs a line of its own, so the title gives one up for it.
  const footHeight = progress ? progressSize * 1.15 : 0;
  const maxLines = progress ? 3 : 4;

  // Nested-session indicator: a column of small squares in the left margin,
  // one per nested (worktree) session sharing this button's project folder,
  // so background work hidden behind the window still shows at a glance.
  // When more squares would fit than the column has vertical room for, the
  // last visible one flashes (driven by `pulse`) instead of being dropped.
  const squareSize = 2;
  const squarePitch = 3; // squareSize + 1px gap
  const marginWidth = nestedCount ? 8 : 0;
  const squaresTop = barHeight + 2;
  const squaresBottom = height - footHeight - 2;
  const maxSquares = Math.max(0, Math.floor((squaresBottom - squaresTop) / squarePitch));
  const visibleSquares = Math.min(nestedCount ?? 0, maxSquares);
  const overflowSquare = (nestedCount ?? 0) > maxSquares;
  const squares = Array.from({ length: visibleSquares }, (_, i) => {
    const dim = i === visibleSquares - 1 && overflowSquare && !pulse;
    return `<rect x="3" y="${squaresTop + i * squarePitch}" width="${squareSize}" height="${squareSize}"
                  fill="#ffffff${dim ? "33" : "ee"}" />`;
  }).join("");

  // The label's wrap width and horizontal center both make room for the
  // margin column above — not just drawn on top of it — so a long line
  // can't run through the squares.
  const textWidth = width - marginWidth;
  const textCenterX = marginWidth + textWidth / 2;

  // Lowercase body against the header's uppercase caps, so the two rows read
  // as distinct typographic levels rather than fighting for the same weight.
  let lines = wrapLabel(label.toLowerCase(), textWidth, fontSize);
  if (lines.length > maxLines) {
    // aiTitle can be a full sentence; anything past what the key can show
    // vertically gets cut, with the last visible line ellipsized.
    const maxChars = Math.max(3, Math.floor(textWidth / (fontSize * 0.6)));
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)) + "…";
  }

  // Centre the title in what's left between the accent bar and the count.
  const bodyTop = barHeight;
  const bodyHeight = height - barHeight - footHeight;
  const startY = bodyTop + bodyHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${textCenterX}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const done = progress ? Math.round((progress.current / Math.max(1, progress.total)) * width) : 0;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      ${accent ? `<rect width="${width}" height="${titleHeight}" fill="${accent}" />` : ""}
      ${
        // The lower border doubles as the context gauge when known — plain
        // dark line otherwise. Keeps the header a constant height either way.
        project
          ? typeof context === "number"
            ? `<rect y="${titleHeight - titleBorder}" width="${width}" height="${titleBorder}" fill="#000000cc" />
               <rect y="${titleHeight - titleBorder}" width="${(width * Math.min(100, Math.max(0, context))) / 100}"
                     height="${titleBorder}" fill="${usageColor(context)}" />`
            : `<rect y="${titleHeight - titleBorder}" width="${width}" height="${titleBorder}" fill="#000000aa" />`
          : ""
      }
      ${
        caps
          ? `<text x="50%" y="${titleTopPad + titleBorder + titleTextRow / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.5" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(caps)}</text>`
          : ""
      }
      <text font-family="sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="0.1" fill="#ffffff"
            text-anchor="middle" dominant-baseline="middle">${tspans}</text>
      ${squares}
      ${
        progress
          ? `<rect y="${height - 3}" width="${width}" height="3" fill="#00000055" />
             <rect y="${height - 3}" width="${done}" height="3" fill="#ffffffcc" />
             <text x="50%" y="${height - footHeight / 2 - 2}" font-family="sans-serif"
                   font-size="${progressSize}" fill="#ffffffdd" text-anchor="middle"
                   dominant-baseline="middle">${progress.current}/${progress.total}</text>`
          : ""
      }
    </svg>`;

  return sharp(Buffer.from(svg))
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes, and eyeball the output**

Run: `npm run render-check`
Expected: `OK: nested indicator, overlay tile, margin-reserved wrapping`

Then open the written PNGs and confirm visually:
- `scripts/render-check-nested-small.png` — 4 small squares below the title bar, left margin.
- `scripts/render-check-nested-overflow.png` — squares fill the column, the last one visibly different (it's the flash frame with `pulse` unset, so it should render dim).
- `scripts/render-check-overlay.png` — caps read `AI-CODE-DETECTION`, not a parent project name.
- `scripts/render-check-margin.png` — the wrapped label sits clear of the square column on the left.

- [ ] **Step 5: Commit**

```bash
git add src/render.mjs scripts/render-check.mjs
git commit -m "feat: render nested-session indicator squares, reserve their margin in label wrap"
```

---

## Task 4: Double-press overlay (`src/index.mjs`)

**Files:**
- Modify: `src/index.mjs` — `refresh()` (currently lines 165-212), `pulse()` (currently lines 220-240), `run()` (currently lines 242-312)
- No new automated test — this task is entirely interactive/hardware-bound (device input, window focus), matching this codebase's existing convention that only pure exported helpers (`assignSlots`, `accentFor`) get scripted checks; `refresh`, `pulse`, `run`, and the press handler are verified by running the daemon. Step 4 below is a manual verification procedure using the live worktree session already confirmed present on this machine.

**Interfaces:**
- Consumes: `btn.nestedSessions` (Task 2's `nestedBySlot`, read per-button), `nestedCount` param on `renderKey` (Task 3).
- Produces: nothing consumed by a later task — this is the last task.

- [ ] **Step 1: Wire `nestedSessions` and `nestedCount` through `refresh()`**

In `src/index.mjs`, add a `nestedBySlot` array alongside `slots` in `run()`. Find this line (currently around line 262):

```js
  const slots = new Array(buttons.length).fill(null);
```

and add immediately after it:

```js
  const nestedBySlot = new Array(buttons.length).fill(null);
```

Then update every call site that currently passes `slots` alone to `refresh`/`assignSlots` to also pass `nestedBySlot`. `refresh`'s signature (currently `async function refresh(deck, buttons, slots)`, around line 165) becomes:

```js
async function refresh(deck, buttons, slots, nestedBySlot) {
  const sessions = await getLiveSessions();
  assignSlots(sessions, slots, nestedBySlot);
  const byId = new Map(sessions.map((s) => [s.session_id, s]));

  await Promise.all(
    buttons.map(async (btn, slot) => {
      const session = slots[slot] ? byId.get(slots[slot]) : null;
      btn.assigned = session ?? null;
      btn.nestedSessions = nestedBySlot[slot] ?? [];

      if (!session) {
        btn.renderParams = null;
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      const label = session.clearedEmpty
        ? ""
        : session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;

      const accent = accentFor(session.folder);
      const project = session.folder.split("/").filter(Boolean).pop() ?? "";
      const progress = session.progress;
      const nestedCount = btn.nestedSessions.length;
      btn.renderParams = { state: session.state, label, accent, project, progress, context: session.context, nestedCount };

      const drawn = `${session.state} ${accent} ${project} ${progress?.current}/${progress?.total} ${session.context} ${label} ${nestedCount}`;
      if (btn.drawn === drawn) return;
      await deck.fillKeyBuffer(btn.index, await renderKey({ ...btn, ...btn.renderParams }), { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}
```

(What changed from the current body: the new `nestedBySlot` param, `assignSlots(sessions, slots, nestedBySlot)`, the `btn.nestedSessions = ...` line, and `nestedCount` added to both `btn.renderParams` and the `drawn` signature string. The comment block above the label-fallback chain is unchanged and omitted here for brevity — leave it as-is in the file.)

- [ ] **Step 2: Add `refreshNested` and extend `pulse`'s redraw filter**

Add this new function right after `refresh` (after its closing brace):

```js
// The nested-session overlay: same rendering and blank/diffing conventions
// as refresh(), but drawn from a fixed set of session ids captured once at
// the moment the overlay opened (nestedView.order) rather than a fresh
// assignSlots pass — order stays put for the visit even as content updates.
async function refreshNested(deck, buttons, nestedView) {
  const sessions = await getLiveSessions();
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const accent = accentFor(nestedView.folder);

  await Promise.all(
    buttons.map(async (btn, i) => {
      const sessionId = nestedView.order[i];
      const session = sessionId ? byId.get(sessionId) : null;
      btn.assigned = null; // nested tiles have no window to focus
      // pulse() is paused while the overlay shows (see the run() change
      // below), but the instant it's dismissed, pulse resumes on its own
      // 400ms tick and reads whatever btn.renderParams already holds —
      // which, without this, would still be each button's pre-overlay data,
      // stale by however long the overlay was open. Nulling it here means
      // pulse's filter (state/nestedCount) finds nothing to redraw until the
      // next refresh() repopulates it, at most 2s later.
      btn.renderParams = null;

      if (!session) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }
      const label = session.clearedEmpty
        ? ""
        : session.aiTitle ?? session.name ?? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
      const project = session.cwd.split("/").filter(Boolean).pop() ?? "";
      const progress = session.progress;

      const drawn = `nested ${session.state} ${project} ${progress?.current}/${progress?.total} ${session.context} ${label}`;
      if (btn.drawn === drawn) return;
      const buf = await renderKey({ ...btn, state: session.state, label, accent, project, progress, context: session.context });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}
```

Then in `pulse()` (currently around line 220), change the redraw filter from:

```js
          buttons
            .filter((btn) => btn.renderParams?.state === "requires_action")
```

to:

```js
          buttons
            .filter((btn) => btn.renderParams?.state === "requires_action" || (btn.renderParams?.nestedCount ?? 0) > 0)
```

(this is deliberately broad — it also re-renders non-overflowing nested-indicator buttons every 400ms for no visible change, since `renderKey` only actually alters output when there's an overflow square to blink; recomputing a handful of small SVGs on a 15-key device is not worth a second, more precise predicate here).

- [ ] **Step 3: Add the press-handling state machine and the poll-loop branch**

In `run()`, find the state declarations (currently around line 264-267):

```js
  let disconnected = false;
  // Toggled by pressing the usage key; the key itself keeps rendering the
  // same either way — it's the 14 session buttons that switch content.
  let statsMode = false;
```

and add after `statsMode`:

```js
  // { folder, order: [session_id, ...] } while the nested-session overlay is
  // showing, otherwise null. `order` is captured once when the overlay opens
  // and never re-sorted — see refreshNested.
  let nestedView = null;
  // The immediately preceding key-down, updated on every press regardless of
  // what it did — this is what makes a second press on the same button mean
  // "again", and any other key in between break that chain.
  let lastPress = null;
```

Replace the `deck.on("down", ...)` handler (currently around lines 272-281):

```js
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    if (control.index === usageButton.index) {
      statsMode = !statsMode;
      return;
    }
    if (statsMode) return; // stat tiles aren't clickable
    const btn = buttons[control.index];
    if (btn?.assigned) focusWindow(btn.assigned.folder);
  });
```

with:

```js
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const btn = control.index === usageButton.index ? null : buttons[control.index];
    const sessionId = btn?.assigned?.session_id ?? null;

    if (nestedView) {
      nestedView = null;
      lastPress = { index: control.index, session_id: sessionId };
      return;
    }
    if (control.index === usageButton.index) {
      statsMode = !statsMode;
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (statsMode) {
      lastPress = { index: control.index, session_id: sessionId };
      return; // stat tiles aren't clickable
    }

    const isRepeat = sessionId !== null && lastPress?.index === control.index && lastPress?.session_id === sessionId;
    if (isRepeat && btn.nestedSessions?.length) {
      nestedView = { folder: btn.assigned.folder, order: btn.nestedSessions.map((s) => s.session_id) };
    } else if (btn?.assigned) {
      focusWindow(btn.assigned.folder);
    }
    lastPress = { index: control.index, session_id: sessionId };
  });
```

Update the `pulse(...)` call (currently around line 285):

```js
  pulse(deck, buttons, () => statsMode, () => disconnected);
```

to also pause while the overlay is up:

```js
  pulse(deck, buttons, () => statsMode || !!nestedView, () => disconnected);
```

Update the main poll loop (currently around lines 287-309) — find:

```js
      if (statsMode) {
        // ...
        await refreshStats(deck, buttons, [...resetTiles, ...(await getStats())]);
      } else {
        await refresh(deck, buttons, slots);
      }
```

and change the `else` branch to:

```js
      } else if (nestedView) {
        await refreshNested(deck, buttons, nestedView);
      } else {
        await refresh(deck, buttons, slots, nestedBySlot);
      }
```

- [ ] **Step 4: Manual verification with the live worktree session on this machine**

This machine currently has a real reproduction: `kob/kob-backend` has an open VS Code window and a background worktree session at `.worktrees/ai-code-detection`. Confirm it's still running:

```bash
cat ~/.claude/sessions/88097.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cwd'], d['status'])"
```

If it prints `/Users/wouterd/projects/kob/kob-backend/.worktrees/ai-code-detection <status>`, the repro is live. If it's gone (the background session finished), start a new one via a worktree-isolated `Agent` or `Workflow` call targeting any project with an open VS Code window, or use the `superpowers:using-git-worktrees` skill, then re-check.

With the daemon running (`npm start`, Stream Deck attached):

1. Confirm the `kob-backend` block now shows only its real sessions — no fourth phantom button for `ai-code-detection`.
2. Confirm the block's first button shows a small square in its left margin (one nested session).
3. Press that button once: VS Code's `kob-backend` window should focus, same as before this change.
4. Press the same button again, immediately: instead of refocusing, the whole board should switch to the overlay — one tile showing the `ai-code-detection` session, caps reading `AI-CODE-DETECTION`.
5. Press any key (including the bottom-right usage key): the board returns to the normal session view.
6. Press a *different* project's button once, then press the `kob-backend` first button once: it should focus (not open the overlay) — confirms a key pressed in between breaks the "again" chain.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs
git commit -m "feat: nested-session overlay via double-press, indicator-aware pulse"
```
