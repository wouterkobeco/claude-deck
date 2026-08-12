# Board Density and Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a state's age on every key, give the attention queue its own key and view, and turn the second press on a session key into that session's full task list.

**Architecture:** Six tasks against the existing six-module daemon. Nothing new is read from disk that isn't already being read: time comes from a field `getLiveSessions()` already returns and drops, model/effort come from the transcript tail scan that already runs, and the full task list is read only while the detail view is open. `render.mjs` stays pure (geometry + data in, RGBA buffer out); `index.mjs` keeps owning view state and diffing.

**Tech Stack:** Node ESM, `sharp` for SVG→RGBA, `@elgato-stream-deck/node`. No test framework — the checks are `scripts/*-check.mjs` files that import from `src/`, compare against expected values, and `process.exit(1)` on mismatch.

## Global Constraints

- **Read-only.** The daemon reads from `~/.claude/`, VS Code storage, and the usage endpoint. No hooks, no `settings.json` writes, no config file. Keys only focus windows.
- **No new data sources.** Everything in this plan comes from files already being read.
- **MK.2 geometry:** 15 keys, 72×72. Session slots drop from 14 to 13.
- **Every file read is wrapped in try/catch that skips rather than throws** — these files are written by another process and a poll can land mid-write.
- **`btn.drawn` is the redraw diff.** Any new visual input must be added to that signature string or it will not appear until something else changes.
- **Ordering is first-seen, never activity** — except the attention queue, which sorts by wait time on purpose (Task 2).
- **Run checks with:** `npm run render-check`, `npm run slots-check`, `npm run tasks-check`, `npm run usage-check`. Run all four before every commit.

---

### Task 1: Time in current state

`getLiveSessions()` already returns `ts` (unix seconds, from `statusUpdatedAt` falling back to `updatedAt`) on every session and no caller reads it. This task formats it and puts it in the accent bar.

**Files:**
- Modify: `src/render.mjs` — add `formatAge`, add `age` to `renderKey`
- Modify: `src/index.mjs:~285-307` — compute `age`, pass it, add it to the `drawn` signature
- Test: `scripts/render-check.mjs`

**Interfaces:**
- Produces: `formatAge(seconds: number) => string` exported from `src/render.mjs`. Returns `""` for non-finite or negative input.
- Produces: `renderKey({ ..., age })` — `age` is a pre-formatted string or `""`.

- [ ] **Step 1: Write the failing test**

`scripts/render-check.mjs` has no equality helper yet. Add one at the top, under the existing imports, then the cases. Change the import line to include `formatAge`:

```js
import { renderKey, formatAge } from "../src/render.mjs";

const eq = (got, want, label) => {
  if (got !== want) {
    console.error(`FAILED (${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
};

// Compact age for the accent bar: it shares 72px with the project name, so
// seconds below a minute, whole minutes below an hour, h+mm past that.
eq(formatAge(0), "0s", "zero seconds");
eq(formatAge(45), "45s", "under a minute");
eq(formatAge(60), "1m", "exactly a minute");
eq(formatAge(3599), "59m", "under an hour");
eq(formatAge(3600), "1h00m", "exactly an hour");
eq(formatAge(8040), "2h14m", "hours and minutes");
// A session with no usable timestamp must render nothing rather than an age
// counted from the epoch — sessions.mjs falls back to 0 when the registry
// carries neither statusUpdatedAt nor updatedAt.
eq(formatAge(-1), "", "negative input");
eq(formatAge(NaN), "", "non-numeric input");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run render-check`
Expected: FAIL — `SyntaxError: The requested module '../src/render.mjs' does not provide an export named 'formatAge'`

- [ ] **Step 3: Write minimal implementation**

In `src/render.mjs`, above `escapeXml`:

```js
/**
 * Compact age for a key. Kept short because it shares the accent bar with the
 * project name: seconds below a minute, whole minutes below an hour, h+mm
 * past that. Empty string for anything unusable, so a session whose registry
 * entry carries no timestamp draws no age rather than one counted from 1970.
 */
export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run render-check`
Expected: PASS — the existing `OK:` lines plus no failures.

- [ ] **Step 5: Draw the age in the accent bar**

In `src/render.mjs`, add `age` to the `renderKey` destructuring:

```js
export async function renderKey({ width, height, state, label, accent, project, progress, context, pulse, nestedStates, age }) {
```

Replace the `const caps = ...` line (currently `const caps = project ? fitCaps(project, width, capSize) : "";`) with:

```js
  // The age sits right-aligned in the bar, so the caps get fitted to — and
  // centred in — what's left, rather than being centred across the full width
  // and running under it.
  const ageWidth = age ? age.length * capSize * 0.62 + 4 : 0;
  const caps = project ? fitCaps(project, width - ageWidth, capSize) : "";
```

Then in the SVG, replace the existing caps `<text>` block with this pair (the caps `x` changes from `50%`):

```js
      ${
        caps
          ? `<text x="${(width - ageWidth) / 2}" y="${titleTopPad + titleBorder + titleTextRow / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.5" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(caps)}</text>`
          : ""
      }
      ${
        age && project
          ? `<text x="${width - 3}" y="${titleTopPad + titleBorder + titleTextRow / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.3" fill="#00000099" text-anchor="end"
                   dominant-baseline="middle">${escapeXml(age)}</text>`
          : ""
      }
```

- [ ] **Step 6: Add a render case for the crowded header**

Append to `scripts/render-check.mjs`, before its final `console.log`:

```js
// The accent bar carries the project name and the age together. A long name
// beside the longest age is where the caps re-fit either truncates sensibly
// or collides — this writes a PNG to look at, byte length can't judge it.
for (const [name, project, age] of [
  ["age-short", "kob-trace", "45s"],
  ["age-long", "claude-streamdeck", "2h14m"],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "serializing client-block mutations",
    accent: "#4fc3f7",
    project,
    age,
  });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}
```

- [ ] **Step 7: Wire it into the board**

In `src/index.mjs`, import `formatAge`:

```js
import { renderKey, renderBlank, renderUsage, renderStat, formatAge } from "./render.mjs";
```

In `refresh()`, after the `const nestedStates = ...` line, add:

```js
      // `ts` is 0 when the registry entry carried neither statusUpdatedAt nor
      // updatedAt; formatAge would otherwise report the age of the epoch.
      const age = session.ts ? formatAge(Date.now() / 1000 - session.ts) : "";
```

Add `age` to `btn.renderParams` and to the `drawn` string. The signature must carry the **formatted** string, not `session.ts` — with the raw timestamp every key re-encodes on every 2s poll instead of once a minute:

```js
      btn.renderParams = { state: session.state, label, accent, project, progress, context: session.context, nestedStates, age };

      const drawn = `${session.state} ${accent} ${project} ${progress?.current}/${progress?.total} ${session.context} ${label} ${nestedStates} ${age}`;
```

- [ ] **Step 8: Run all four checks**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check`
Expected: all PASS. Open `scripts/render-check-age-long.png` and confirm the age is readable and the project name is not overrun.

- [ ] **Step 9: Commit**

```bash
git add src/render.mjs src/index.mjs scripts/render-check.mjs
git commit -m "feat: show time in current state on each key"
```

---

### Task 2: Attention key

Reserves key 13 and draws the resting tile. The view behind it is Task 3.

**Files:**
- Modify: `src/index.mjs` — `attentionQueue()`, reserve the button, `drawAttention()`
- Modify: `src/render.mjs` — `renderAttention()`
- Test: `scripts/slots-check.mjs`, `scripts/render-check.mjs`

**Interfaces:**
- Produces: `attentionQueue(sessions: Session[], nowSeconds: number) => Session[]` exported from `src/index.mjs`. `requires_action` before `waiting`; within a group, oldest `ts` first; ties broken by `session_id` so the order is stable across polls.
- Produces: `renderAttention({ width, height, count, longest, pulse })` from `src/render.mjs`. `longest` is a pre-formatted age string or `""`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/slots-check.mjs`, before its final `console.log`. Note `s()` in that file builds `{session_id, folder, nested}` — these cases need `state` and `ts`, so build the objects directly:

```js
// The attention queue is the one board that sorts by activity: blocked ahead
// of waiting, longest-stuck first inside each group. Nested sessions are
// included — they have no key of their own, so this is the only view that can
// give them a title.
const q = (id, state, ts, nested = false) => ({ session_id: id, folder: "/projects/q", state, ts, nested });
const ids = (list) => list.map((x) => x.session_id);

eq(
  ids(attentionQueue([q("a", "waiting", 100), q("b", "requires_action", 500)], 1000)),
  ["b", "a"],
  "requires_action outranks waiting regardless of age"
);
eq(
  ids(attentionQueue([q("new", "waiting", 900), q("old", "waiting", 100)], 1000)),
  ["old", "new"],
  "longest-stuck first inside a group"
);
eq(
  ids(attentionQueue([q("busy1", "busy", 100), q("idle1", "idle", 100), q("w", "waiting", 100)], 1000)),
  ["w"],
  "only blocked and waiting sessions appear"
);
eq(
  ids(attentionQueue([q("n", "waiting", 100, true), q("r", "waiting", 200)], 1000)),
  ["n", "r"],
  "nested sessions are included"
);
// Equal timestamps must not let two sessions swap places between polls.
eq(
  ids(attentionQueue([q("b", "waiting", 100), q("a", "waiting", 100)], 1000)),
  ["a", "b"],
  "ties broken stably"
);
eq(attentionQueue([], 1000).length, 0, "nothing waiting");
```

Add `attentionQueue` to the import at the top of the file:

```js
import { assignSlots, accentFor, attentionQueue } from "../src/index.mjs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run slots-check`
Expected: FAIL — `does not provide an export named 'attentionQueue'`

- [ ] **Step 3: Write minimal implementation**

In `src/index.mjs`, below `accentFor`:

```js
// Ranked, not ordered: this is the one board that sorts by activity rather
// than first-seen. It's transient triage — you read it, act, and leave — so
// there's no muscle memory for it to break. Nested sessions are in here
// because the queue is the only view that gives them a key at all; on the
// board they're a 3×6px square in someone else's margin.
const ATTENTION_RANK = { requires_action: 0, waiting: 1 };
export function attentionQueue(sessions, nowSeconds) {
  return sessions
    .filter((s) => s.state in ATTENTION_RANK)
    .sort(
      (a, b) =>
        ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state] ||
        (a.ts || nowSeconds) - (b.ts || nowSeconds) ||
        a.session_id.localeCompare(b.session_id)
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run slots-check`
Expected: PASS — `OK: project grouping`

- [ ] **Step 5: Write the attention key renderer**

In `src/render.mjs`, after `renderUsage`:

```js
/**
 * The attention key: how many sessions want you, and how long the worst one
 * has been waiting. Dark and quiet at zero — an empty queue should read as
 * "nothing to do here", not as a key that failed to draw.
 */
export async function renderAttention({ width, height, count, longest, pulse }) {
  const capSize = Math.round(height * 0.11);
  const countSize = Math.round(height * 0.34);
  const quiet = count === 0;
  const bg = quiet ? "#1b1b1b" : pulse ? "#ff5252" : "#c62828";

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${bg}" />
      <text x="50%" y="${height * 0.38}" font-family="sans-serif" font-size="${quiet ? capSize : countSize}"
            font-weight="bold" fill="${quiet ? "#ffffff55" : "#ffffff"}" text-anchor="middle"
            dominant-baseline="middle">${quiet ? "CLEAR" : count}</text>
      ${
        quiet
          ? ""
          : `<text x="50%" y="${height * 0.66}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.5" fill="#ffffffcc" text-anchor="middle"
                   dominant-baseline="middle">WAITING</text>
             <text x="50%" y="${height * 0.85}" font-family="sans-serif" font-size="${capSize}"
                   fill="#ffffff99" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(longest ?? "")}</text>`
      }
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}
```

- [ ] **Step 6: Add render cases**

Append to `scripts/render-check.mjs`, before its final `console.log`, and add `renderAttention` to its import from `../src/render.mjs`:

```js
// Attention key at rest and under load. Zero is a distinct visual state, not
// a red key showing "0".
for (const [name, count, longest] of [
  ["attention-clear", 0, ""],
  ["attention-two", 2, "14m"],
]) {
  const buf = await renderAttention({ width, height, count, longest });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}
```

- [ ] **Step 7: Reserve the key and draw it**

In `src/index.mjs`, import `renderAttention` alongside the others. In `run()`, replace:

```js
  // Keys are row-major, so the highest index is the bottom-right one.
  const usageButton = allButtons.pop();
  const buttons = allButtons;
```

with:

```js
  // Keys are row-major, so the highest index is the bottom-right one, and the
  // one before it is bottom-row-second-from-right. Both are reserved, leaving
  // 13 session slots.
  const usageButton = allButtons.pop();
  const attentionButton = allButtons.pop();
  const buttons = allButtons;
```

Add a draw function next to `drawUsage`:

```js
// Same drawn-signature diffing as every other key. Pulses with the board's
// requires_action keys when anything is blocked, so the two agree.
async function drawAttention(deck, btn, sessions, pulse) {
  const queue = attentionQueue(sessions, Date.now() / 1000);
  const longest = queue.length && queue[0].ts ? formatAge(Date.now() / 1000 - queue[0].ts) : "";
  const drawn = `attention ${queue.length} ${longest} ${pulse}`;
  if (btn.drawn !== drawn) {
    await deck.fillKeyBuffer(btn.index, await renderAttention({ ...btn, count: queue.length, longest, pulse }), {
      format: "rgba",
    });
    btn.drawn = drawn;
  }
  // Returned rather than re-derived by the press handler: a press needs to
  // know whether there's anything to open, and reading that back out of the
  // `drawn` signature string would couple key presses to a render-diffing
  // detail that changes the moment this key gains anything else to show.
  return queue.length;
}
```

`run()` keeps the latest count so the press handler can use it. Declare it with the other view state:

```js
  let attentionCount = 0;
```

and assign it at every call site: `attentionCount = await drawAttention(...)`.

`refresh()` already calls `getLiveSessions()`; return those sessions from it so the loop can pass them on without a second read. Change the end of `refresh()` to `return sessions;`, and in the poll loop capture and use it:

```js
        const sessions = await refresh(deck, buttons, slots, nestedBySlot);
        await drawAttention(deck, attentionButton, sessions, false);
```

For the other view branches, which don't call `refresh()`, call `drawAttention(deck, attentionButton, await getLiveSessions(), false)` — the attention count must stay live in every view.

- [ ] **Step 8: Run all four checks**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check`
Expected: all PASS. Open `scripts/render-check-attention-two.png` and `-clear.png`.

- [ ] **Step 9: Commit**

```bash
git add src/index.mjs src/render.mjs scripts/slots-check.mjs scripts/render-check.mjs
git commit -m "feat: attention key showing how many sessions are blocked"
```

---

### Task 3: Attention view and single view state

Collapses `statsMode` (boolean) and `nestedView` (object) into one `view` value, then adds the attention board behind the key from Task 2. The collapse belongs here: this is the change that would otherwise make it a four-way boolean tangle.

**Files:**
- Modify: `src/index.mjs` — `run()` view state and press handling, `refreshAttention()`, `pulse()` signature

**Interfaces:**
- Consumes: `attentionQueue()` from Task 2.
- Produces: `view` — `{ kind: "sessions" } | { kind: "stats" } | { kind: "attention" } | { kind: "detail", session_id, order }`. Local to `run()`, as `statsMode` and `nestedView` are today.

- [ ] **Step 1: Replace the two view variables**

In `run()`, replace the `statsMode` and `nestedView` declarations with:

```js
  // Which board is showing. One value rather than a flag per view: with four
  // of them, "stats and detail are both somehow on" is a state that shouldn't
  // be representable.
  //   { kind: "sessions" }
  //   { kind: "stats" }
  //   { kind: "attention" }
  //   { kind: "detail", session_id, order: [session_id, ...] }  (Task 6)
  // `order` is captured when the view opens and never re-sorted.
  let view = { kind: "sessions" };
```

- [ ] **Step 2: Rewrite the press handler**

Replace the whole body of `deck.on("down", ...)` with:

```js
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const isUsage = control.index === usageButton.index;
    const isAttention = control.index === attentionButton.index;
    const btn = isUsage || isAttention ? null : buttons[control.index];
    const sessionId = btn?.assigned?.session_id ?? null;
    const press = { index: control.index, session_id: sessionId };

    // Any press leaves an overlay, including the key that opened it.
    if (view.kind === "attention" || view.kind === "detail") {
      const wasAttention = view.kind === "attention";
      view = { kind: "sessions" };
      // In the queue a session key still focuses its window on the way out —
      // that's the whole point of pressing one there.
      if (wasAttention && btn?.assigned) focusWindow(btn.assigned.folder, btn.assigned.ide);
      lastPress = press;
      return;
    }
    if (isUsage) {
      view = view.kind === "stats" ? { kind: "sessions" } : { kind: "stats" };
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (isAttention) {
      // Dark key, nothing queued: a press has nothing to show, so it does
      // nothing rather than opening an empty board. `attentionCount` is what
      // the last drawAttention() returned.
      if (attentionCount > 0) view = { kind: "attention" };
      lastPress = { index: control.index, session_id: null };
      return;
    }
    if (view.kind === "stats") {
      lastPress = press;
      return; // stat tiles aren't clickable
    }

    const isRepeat = sessionId !== null && lastPress?.index === control.index && lastPress?.session_id === sessionId;
    if (isRepeat) {
      view = { kind: "detail", session_id: sessionId, order: [] }; // filled in Task 6
    } else if (btn?.assigned) {
      focusWindow(btn.assigned.folder, btn.assigned.ide);
    }
    lastPress = press;
  });
```

Note the attention no-op test reads `attentionButton.drawn`, which `drawAttention` sets to `attention 0  false` when the queue is empty (count `0`, empty `longest`, `pulse` false — two spaces, on purpose).

- [ ] **Step 3: Update the loop and pulse**

Replace the `if (statsMode) / else if (nestedView) / else` chain with a switch on `view.kind`, and change the `pulse(...)` call's second predicate from `() => statsMode || !!nestedView` to `() => view.kind !== "sessions"`.

```js
      if (view.kind === "stats") {
        const { sessionResetsAt, weekResetsAt } = await getUsage();
        const sessionHours = hoursUntil(sessionResetsAt);
        const weekDays = daysUntil(weekResetsAt);
        const resetTiles = [
          { label: "Session reset", value: sessionHours === null ? "—" : `${sessionHours}h` },
          { label: "Week reset", value: weekDays === null ? "—" : `${weekDays}d` },
        ];
        await refreshStats(deck, buttons, [...resetTiles, ...(await getStats())]);
        await drawAttention(deck, attentionButton, await getLiveSessions(), false);
      } else if (view.kind === "attention") {
        await refreshAttention(deck, buttons, attentionButton);
      } else {
        const sessions = await refresh(deck, buttons, slots, nestedBySlot);
        await drawAttention(deck, attentionButton, sessions, false);
      }
```

(The `detail` branch is added in Task 6.)

- [ ] **Step 4: Write the attention board**

Next to `refreshStats`:

```js
// The attention board: the queue across the session keys, re-ranked every
// poll. Unlike the detail view this deliberately re-sorts while it's up — a
// session that gets unblocked should leave the queue you're looking at.
async function refreshAttention(deck, buttons, attentionButton) {
  const sessions = await getLiveSessions();
  const queue = attentionQueue(sessions, Date.now() / 1000);
  await drawAttention(deck, attentionButton, sessions, false);

  await Promise.all(
    buttons.map(async (btn, i) => {
      const session = queue[i] ?? null;
      btn.assigned = session;
      btn.renderParams = null; // see refreshNested: keeps pulse off stale data

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
      const project = session.folder.split("/").filter(Boolean).pop() ?? "";
      const age = session.ts ? formatAge(Date.now() / 1000 - session.ts) : "";

      const drawn = `queue ${session.state} ${project} ${label} ${age}`;
      if (btn.drawn === drawn) return;
      const buf = await renderKey({
        ...btn,
        state: session.state,
        label,
        accent: accentFor(session.folder),
        project,
        context: session.context,
        age,
      });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}
```

- [ ] **Step 5: Run all four checks**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check`
Expected: all PASS. These checks don't exercise `run()`, so also start the daemon (`npm start`) with the deck plugged in and confirm: the board shows 13 session keys, the usage key still toggles stats, the attention key opens and closes the queue, and pressing a session in the queue focuses its window.

- [ ] **Step 6: Commit**

```bash
git add src/index.mjs
git commit -m "feat: attention queue view, one view state instead of two flags"
```

---

### Task 4: Model and effort from the transcript tail

The detail view's header needs them. Both ride on `type:"assistant"` lines the existing backward scan in `readTranscriptSignals` already walks — `message.model` (e.g. `"claude-opus-5"`) and a top-level `effort` (e.g. `"high"`). No second read.

**Files:**
- Modify: `src/sessions.mjs` — `readTranscriptSignals`
- Test: `scripts/tasks-check.mjs` is for the counter; add a new `scripts/transcript-check.mjs`

**Interfaces:**
- Produces: `readTranscriptSignals(path)` gains `model: string | null` and `effort: string | null` in its return object. `getLiveSessions()` already spreads `...signals` onto each session, so both appear on sessions automatically.

- [ ] **Step 1: Write the failing test**

Create `scripts/transcript-check.mjs`:

```js
// Verifies the transcript tail scan: model/effort come from the newest
// assistant line, and the existing /clear and denial signals still hold.
// Run: node scripts/transcript-check.mjs
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptSignals } from "../src/sessions.mjs";

const eq = (got, want, label) => {
  if (got !== want) {
    console.error(`FAILED (${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
};

const dir = await mkdtemp(join(tmpdir(), "transcript-check-"));
const write = async (name, lines) => {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
};

// Newest assistant line wins for both fields.
const p1 = await write("models.jsonl", [
  { type: "assistant", effort: "low", message: { model: "claude-sonnet-5" } },
  { type: "user", message: { content: [] } },
  { type: "assistant", effort: "high", message: { model: "claude-opus-5" } },
]);
const a = await readTranscriptSignals(p1);
eq(a.model, "claude-opus-5", "newest assistant model");
eq(a.effort, "high", "newest assistant effort");

// A transcript with no assistant line yet reports null rather than guessing.
const p2 = await write("empty.jsonl", [{ type: "user", message: { content: [] } }]);
const b = await readTranscriptSignals(p2);
eq(b.model, null, "no assistant line yet");
eq(b.effort, null, "no effort yet");

// A missing file must not throw — a poll can land before the file exists.
const c = await readTranscriptSignals(join(dir, "does-not-exist.jsonl"));
eq(c.model, null, "missing file");
eq(c.aiTitle, null, "missing file keeps existing contract");

console.log("OK: transcript signals");
```

Register it in `package.json` scripts:

```json
"transcript-check": "node scripts/transcript-check.mjs"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run transcript-check`
Expected: FAIL — `FAILED (newest assistant model): got undefined, want "claude-opus-5"`

- [ ] **Step 3: Write minimal implementation**

In `src/sessions.mjs`, inside `readTranscriptSignals`, add to the declarations beside `blockedOnDenial`:

```js
    let model = null,
      effort = null,
      modelResolved = false;
```

Extend the loop condition to include the new flag:

```js
    for (let i = lines.length - 1; i >= 0 && (!titleResolved || !denialResolved || !modelResolved); i--) {
```

Add inside the loop, after the denial block:

```js
      // Model and effort ride on assistant lines; the newest one is what the
      // session is running right now. Same scan, no extra read.
      if (!modelResolved && line.includes('"type":"assistant"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.message?.model) {
            model = obj.message.model;
            effort = obj.effort ?? null;
            modelResolved = true;
          }
        } catch {
          // truncated line at the start of the tail slice — keep scanning
        }
      }
```

Return them, and add them to the catch-path default so the shape never varies:

```js
    return { aiTitle, clearedEmpty, blockedOnDenial, model, effort };
  } catch {
    return { aiTitle: null, clearedEmpty: false, blockedOnDenial: false, model: null, effort: null };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run transcript-check`
Expected: PASS — `OK: transcript signals`

- [ ] **Step 5: Run all checks**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check && npm run transcript-check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.mjs scripts/transcript-check.mjs package.json
git commit -m "feat: read model and effort from the transcript tail"
```

---

### Task 5: Full task list and its window

The detail view needs every task, not just the counter, and needs to pick which ones fit when there are more tasks than keys.

**Files:**
- Modify: `src/sessions.mjs` — extract the read, export `readTaskList` and `taskWindow`
- Test: `scripts/tasks-check.mjs`

**Interfaces:**
- Produces: `readTaskList(sessionId: string) => Promise<Task[]>` from `src/sessions.mjs`, where `Task` is `{ subject, status }` as written by Claude Code. Returns `[]` when the session has no tasks. Sorted numerically by filename, same as today.
- Produces: `taskWindow(tasks: Task[], size: number) => Task[]` from `src/sessions.mjs` — a contiguous slice of at most `size`, centred on the `in_progress` task.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tasks-check.mjs`, before its final `console.log`. Its existing `eq` compares `current/total`, so these need a separate helper:

```js
import { taskWindow } from "../src/sessions.mjs";

const same = (got, want, label) => {
  const a = JSON.stringify(got.map((t) => t.subject));
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const list = (n) => Array.from({ length: n }, (_, i) => t(`Task ${i + 1}`));
const withActive = (n, activeIndex) => {
  const l = list(n);
  l[activeIndex].status = "in_progress";
  return l;
};

// Fewer tasks than keys: everything shows, untouched.
same(taskWindow(list(3), 8), ["Task 1", "Task 2", "Task 3"], "short list is unchanged");

// The active task sits mid-window when there's room on both sides.
same(
  taskWindow(withActive(20, 9), 5).map((x) => x),
  ["Task 8", "Task 9", "Task 10", "Task 11", "Task 12"],
  "window centres on the in-progress task"
);

// Near the start there's nothing to the left to show — the window must still
// be full, not half-empty.
same(taskWindow(withActive(20, 0), 5), ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"], "clamped at the start");

// Same at the end.
same(
  taskWindow(withActive(20, 19), 5),
  ["Task 16", "Task 17", "Task 18", "Task 19", "Task 20"],
  "clamped at the end"
);

// Nothing in progress: show the first `size`, rather than an empty window.
same(taskWindow(list(20), 3), ["Task 1", "Task 2", "Task 3"], "no active task starts at the top");

same(taskWindow([], 5), [], "empty list");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run tasks-check`
Expected: FAIL — `does not provide an export named 'taskWindow'`

- [ ] **Step 3: Write minimal implementation**

In `src/sessions.mjs`, extract the read that `readTaskProgress` already does into an exported function, and have `readTaskProgress` call it:

```js
/**
 * Every task for a session, in creation order. Task files are named by
 * numeric id, so they're sorted numerically — "10" after "2", not before it.
 * Returns [] for a session that isn't using tasks, and skips any file caught
 * mid-write rather than throwing.
 */
export async function readTaskList(sessionId) {
  const dir = join(TASKS_DIR, sessionId);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const tasks = [];
  for (const name of names) {
    try {
      tasks.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // mid-write — skip
    }
  }
  return tasks;
}

async function readTaskProgress(sessionId) {
  const tasks = await readTaskList(sessionId);
  if (tasks.length === 0) return null;
  return { ...taskCounter(tasks), active: tasks.find((t) => t.status === "in_progress")?.subject ?? null };
}
```

Then add the window:

```js
/**
 * The `size` tasks worth showing. Centred on the in-progress one so you see
 * what's just been done and what's next, clamped at both ends so the window
 * is always full when the list is long enough to fill it. No in-progress task
 * (a finished or not-yet-started list) starts at the top.
 */
export function taskWindow(tasks, size) {
  if (tasks.length <= size) return tasks;
  const active = tasks.findIndex((t) => t.status === "in_progress");
  if (active < 0) return tasks.slice(0, size);
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), tasks.length - size));
  return tasks.slice(start, start + size);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run tasks-check`
Expected: PASS — `OK: task counter`

- [ ] **Step 5: Run all checks**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check && npm run transcript-check`
Expected: all PASS. `readTaskProgress` was refactored, so `tasks-check`'s existing counter cases passing is what confirms nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.mjs scripts/tasks-check.mjs
git commit -m "feat: full task list reader and its display window"
```

---

### Task 6: Session detail view

Second press on any session key opens it. Deletes `refreshNested` and the `nested` overlay mode, whose job moves inside.

**Files:**
- Modify: `src/index.mjs` — `detailLayout()`, `refreshDetail()`, press wiring, delete `refreshNested`
- Modify: `src/render.mjs` — `renderTask()`, `splitLabel()`
- Test: `scripts/slots-check.mjs`, `scripts/render-check.mjs`

**Interfaces:**
- Consumes: `readTaskList`, `taskWindow` (Task 5); `model`, `effort` on sessions (Task 4); `formatAge` (Task 1).
- Produces: `detailLayout({ session, tasks, nested, age, slotCount }) => Tile[]` exported from `src/index.mjs`, length exactly `slotCount`. A `Tile` is one of `{ kind: "label", label }`, `{ kind: "stat", label, value }`, `{ kind: "task", number, subject, status }`, `{ kind: "nested", session }`, or `null`.
- Produces: `splitLabel(label: string, parts: number) => string[]` from `src/render.mjs` — always returns exactly `parts` strings, padding with `""`.
- Produces: `renderTask({ width, height, number, subject, status })` from `src/render.mjs`.

- [ ] **Step 1: Write the failing test for the layout**

Append to `scripts/slots-check.mjs`, before its final `console.log`, and add `detailLayout` to its import:

```js
// The detail board: five header tiles, then tasks, with worktree tiles held
// at the tail so a long task list can't push them off the board entirely.
const dSession = {
  session_id: "d1",
  folder: "/projects/kob-trace",
  state: "busy",
  context: 41,
  model: "claude-opus-5",
  effort: "high",
  aiTitle: "serializing client-block mutations",
};
const dTask = (subject, status = "pending") => ({ subject, status });

const plain = detailLayout({ session: dSession, tasks: [dTask("read the code"), dTask("lock it", "in_progress")], nested: [], age: "40m", slotCount: 13 });
eq(plain.length, 13, "layout always fills the board");
eq(plain.slice(0, 2).map((t) => t.kind), ["label", "label"], "title spans two tiles");
eq(plain[2], { kind: "stat", label: "STATE", value: "busy 40m" }, "state tile carries the age");
eq(plain[3], { kind: "stat", label: "CONTEXT", value: "41%" }, "context tile");
eq(plain[4], { kind: "stat", label: "MODEL", value: "opus-5 high" }, "model tile drops the vendor prefix");
eq(plain[5], { kind: "task", number: 1, subject: "read the code", status: "pending" }, "tasks start at slot 5");
eq(plain[6].status, "in_progress", "task status is carried through");
eq(plain[7], null, "unused slots are null");

// Worktree tiles hold the tail; tasks take what's left in front of them.
const withNested = detailLayout({
  session: dSession,
  tasks: Array.from({ length: 20 }, (_, i) => dTask(`Task ${i + 1}`, i === 0 ? "in_progress" : "pending")),
  nested: [{ session_id: "w1", state: "busy" }, { session_id: "w2", state: "idle" }],
  age: "40m",
  slotCount: 13,
});
eq(withNested.length, 13, "layout still fills the board");
eq(withNested.slice(11).map((t) => t.kind), ["nested", "nested"], "worktree tiles sit at the tail");
eq(withNested.slice(5, 11).every((t) => t.kind === "task"), true, "tasks fill the space in front of them");

// A session with no context reported must not print "null%".
const noCtx = detailLayout({ session: { ...dSession, context: null }, tasks: [], nested: [], age: "", slotCount: 13 });
eq(noCtx[3], { kind: "stat", label: "CONTEXT", value: "—" }, "unknown context shows a dash");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run slots-check`
Expected: FAIL — `does not provide an export named 'detailLayout'`

- [ ] **Step 3: Write the layout**

In `src/index.mjs`, next to `assignSlots`:

```js
// The detail board, as data. Kept separate from drawing so the slot
// arithmetic — which is where an off-by-one silently hides a task — is
// testable without a Stream Deck.
//
// Worktree tiles are pinned to the tail rather than appended after the tasks:
// they're the only way to reach those sessions, and a twenty-task plan would
// otherwise push them off the board.
export function detailLayout({ session, tasks, nested, age, slotCount }) {
  const [titleA, titleB] = splitLabel(session.aiTitle ?? session.name ?? "", 2);
  const header = [
    { kind: "label", label: titleA },
    { kind: "label", label: titleB },
    { kind: "stat", label: "STATE", value: age ? `${session.state} ${age}` : session.state },
    { kind: "stat", label: "CONTEXT", value: typeof session.context === "number" ? `${session.context}%` : "—" },
    {
      kind: "stat",
      label: "MODEL",
      // "claude-opus-5" is three quarters vendor on a 72px key.
      value: [(session.model ?? "").replace(/^claude-/, ""), session.effort ?? ""].filter(Boolean).join(" ") || "—",
    },
  ];

  const nestedTiles = nested.slice(0, Math.max(0, slotCount - header.length)).map((s) => ({ kind: "nested", session: s }));
  const taskRoom = slotCount - header.length - nestedTiles.length;
  const shown = taskWindow(tasks, taskRoom);
  const taskTiles = shown.map((t) => ({
    kind: "task",
    number: tasks.indexOf(t) + 1,
    subject: t.subject ?? "",
    status: t.status ?? "pending",
  }));

  const body = new Array(taskRoom).fill(null);
  taskTiles.forEach((tile, i) => (body[i] = tile));
  return [...header, ...body, ...nestedTiles];
}
```

Add `splitLabel` to `src/render.mjs` and export it:

```js
/**
 * Splits a label into `parts` roughly equal chunks on word boundaries, so a
 * title can run across neighbouring keys. Always returns exactly `parts`
 * strings — short labels leave the later keys blank rather than undefined.
 */
export function splitLabel(label, parts) {
  const words = (label ?? "").split(/\s+/).filter(Boolean);
  const out = new Array(parts).fill("");
  if (words.length === 0) return out;
  const per = Math.ceil(words.length / parts);
  for (let i = 0; i < parts; i++) out[i] = words.slice(i * per, (i + 1) * per).join(" ");
  return out;
}
```

Import `splitLabel` and `taskWindow` into `src/index.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run slots-check`
Expected: PASS — `OK: project grouping`

- [ ] **Step 5: Write the task tile renderer**

In `src/render.mjs`:

```js
// Done recedes, active is the only bright tile, todo sits between them —
// the board should read as "here" at a glance, not as fourteen equal boxes.
const TASK_COLORS = {
  completed: { bg: "#1b3a1e", text: "#ffffff77" },
  in_progress: { bg: "#2e7d32", text: "#ffffff" },
  pending: { bg: "#1b1b1b", text: "#ffffffaa" },
};

/**
 * One task of the detail board: its number small at the top, its subject
 * wrapped below, coloured by status.
 */
export async function renderTask({ width, height, number, subject, status }) {
  const { bg, text } = TASK_COLORS[status] ?? TASK_COLORS.pending;
  const capSize = Math.round(height * 0.11);
  const fontSize = Math.round(height * 0.17);
  const lineHeight = fontSize * 1.05;

  let lines = wrapLabel((subject ?? "").toLowerCase(), width - 6, fontSize);
  const maxLines = 4;
  if (lines.length > maxLines) {
    const maxChars = Math.max(3, Math.floor((width - 6) / (fontSize * 0.6)));
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + "…";
  }
  const startY = height * 0.3 + lineHeight / 2;
  const tspans = lines.map((line, i) => `<tspan x="3" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`).join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${bg}" />
      <text x="3" y="${height * 0.13}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="0.5" fill="${text}" dominant-baseline="middle">${number}</text>
      <text font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="${text}"
            text-anchor="start" dominant-baseline="middle">${tspans}</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}
```

- [ ] **Step 6: Add render cases**

Append to `scripts/render-check.mjs`, adding `renderTask` to its import:

```js
// One task tile per status — the three must be tellable apart at arm's length.
for (const status of ["completed", "in_progress", "pending"]) {
  const buf = await renderTask({ width, height, number: 3, subject: "serialize client-block mutations", status });
  if (buf.length !== expected) {
    console.error(`FAILED (task ${status}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-task-${status}.png`, import.meta.url).pathname);
}
```

- [ ] **Step 7: Draw the detail board and delete the old overlay**

In `src/index.mjs`, replace `refreshNested` entirely with:

```js
// The detail board: one session across every key. Content refreshes each
// poll, but the tile order is fixed by whatever detailLayout produced when
// the view opened — a task completing shouldn't move the tile under your
// finger. Tasks are read here rather than in getLiveSessions so the 2s poll
// costs the same as it did before this view existed.
async function refreshDetail(deck, buttons, view) {
  const sessions = await getLiveSessions();
  const session = sessions.find((s) => s.session_id === view.session_id);
  if (!session) return; // it ended while you were looking at it; any press exits

  const nested = sessions.filter((s) => s.nested && s.folder === session.folder);
  const tasks = await readTaskList(session.session_id);
  const age = session.ts ? formatAge(Date.now() / 1000 - session.ts) : "";
  const tiles = detailLayout({ session, tasks, nested, age, slotCount: buttons.length });
  const accent = accentFor(session.folder);

  await Promise.all(
    buttons.map(async (btn, i) => {
      const tile = tiles[i];
      btn.assigned = null; // detail tiles have no window of their own to focus
      btn.renderParams = null; // see below: keeps pulse off stale data

      if (!tile) {
        if (btn.drawn !== null) {
          await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
          btn.drawn = null;
        }
        return;
      }

      const drawn = `detail ${tile.kind} ${tile.label ?? ""} ${tile.value ?? ""} ${tile.number ?? ""} ${
        tile.subject ?? ""
      } ${tile.status ?? ""} ${tile.session?.state ?? ""}`;
      if (btn.drawn === drawn) return;

      let buf;
      if (tile.kind === "task") {
        buf = await renderTask({ ...btn, ...tile });
      } else if (tile.kind === "stat") {
        buf = await renderStat({ ...btn, label: tile.label, value: tile.value });
      } else if (tile.kind === "nested") {
        buf = await renderKey({
          ...btn,
          state: tile.session.state,
          label: tile.session.aiTitle ?? tile.session.name ?? "",
          accent,
          project: tile.session.cwd.split("/").filter(Boolean).pop() ?? "",
          context: tile.session.context,
        });
      } else {
        buf = await renderKey({ ...btn, state: session.state, label: tile.label, accent, project: "" });
      }
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
      btn.drawn = drawn;
    })
  );
}
```

Add the branch to the poll loop:

```js
      } else if (view.kind === "detail") {
        await refreshDetail(deck, buttons, view);
        await drawAttention(deck, attentionButton, await getLiveSessions(), false);
```

In the press handler from Task 3, the detail case no longer needs `order`:

```js
    if (isRepeat) {
      view = { kind: "detail", session_id: sessionId };
    } else if (btn?.assigned) {
```

Import `readTaskList` from `./sessions.mjs`, and `renderTask` from `./render.mjs`.

- [ ] **Step 8: Run all checks and the daemon**

Run: `npm run render-check && npm run slots-check && npm run tasks-check && npm run usage-check && npm run transcript-check`
Expected: all PASS.

Then `npm start` with the deck plugged in. Confirm: pressing a session key twice opens its detail board; the header reads title / title / state+age / context / model; tasks show with the in-progress one bright; a project with worktree sessions shows them at the bottom right; any press returns to the board.

- [ ] **Step 9: Update the docs**

`CLAUDE.md` describes the nested overlay and the 14-key board, both of which this plan changes. Update:
- The architecture note about `index.mjs` owning "the session/stats view toggle (`statsMode`)" → one `view` value across four boards.
- The nested-session bullet: second press now opens the session detail board, with worktree tiles inside it; `refreshNested` is gone.
- The key count: 13 session slots, key 13 attention, key 14 usage.
- Add the attention queue as the documented exception to "ordering is first-seen, never activity".

`README.md`'s data sources table gains `model`/`effort` and the task list.

- [ ] **Step 10: Commit**

```bash
git add src/index.mjs src/render.mjs scripts/slots-check.mjs scripts/render-check.mjs CLAUDE.md README.md
git commit -m "feat: session detail board on second press, replacing the nested overlay"
```

---

## Self-Review

**Spec coverage.** Time in state → Task 1. Attention key, its resting content and the no-op-at-zero press → Task 2. The queue view, its ordering, nested sessions in it, and the view-state collapse → Task 3. Detail header's model/effort → Task 4. Its task list and windowing → Task 5. The board itself, worktree tiles and deleting `nestedView` → Task 6. Every spec section maps to a task.

**Known deviations from the spec, both deliberate:**
- The spec said the queue's type "gets bigger" with fewer sessions. Task 3 reuses `renderKey` unchanged instead: `renderKey` already grows text to fill the space a short label leaves, and a second font-scaling path would be a second thing to keep in sync. If it reads too small on the device, that's a follow-up with a render-check case, not a hidden requirement.
- The spec put `pulse` on the attention key "on the same beat as a requires_action key". Task 2 passes `pulse: false` from every call site — wiring it into the `pulse()` loop means passing the attention button into a function that currently only knows about session buttons. Left as a follow-up so it doesn't hide inside a larger task; the key is red and carries a count without it.

**Placeholder scan.** No TBDs. The one forward reference — `{ kind: "detail", session_id, order: [] }` in Task 3 — is replaced in Task 6 Step 7, and both are marked.

**Type consistency.** `formatAge` (Task 1) is used by Tasks 2, 3, 6. `attentionQueue(sessions, nowSeconds)` (Task 2) is used by Task 3 and `drawAttention`. `taskWindow(tasks, size)` and `readTaskList(sessionId)` (Task 5) are used by `detailLayout` and `refreshDetail` (Task 6). `nestedStates`, not `nestedCount`, throughout — the rename already shipped. Tile `kind` values are the same five strings in `detailLayout`, its test, and `refreshDetail`.
