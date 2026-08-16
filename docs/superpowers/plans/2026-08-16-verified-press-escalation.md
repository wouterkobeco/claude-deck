# Verified Press Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stream Deck key press escalates to the detail board only when it changed nothing — so pressing a second Claude session's key switches to *its* terminal instead of opening detail.

**Architecture:** The extension publishes per-window state (workspace folders, window focus, which session's terminal is in front) to `~/.claude/streamdeck-windows/<extension-host pid>.json`. The daemon reads it synchronously at press time. A window that publishes nothing isn't running the extension, so its keys keep today's folder-matching behaviour — degradation is per window, not per machine.

**Tech Stack:** Node ESM (daemon, no new dependencies), plain CommonJS (extension, no build step), VS Code stable API only.

**Spec:** `docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md` — the **amendment at the end**, "Verified press escalation" (2026-08-16). Everything before the amendment is already shipped; read it for context, implement the amendment.

## Global Constraints

- **No new dependencies.** Node built-ins only; the extension stays dependency-free and build-free.
- **Node ESM `.mjs`** on the daemon side (`"type": "module"`); **CommonJS `.js`** in `extension/`.
- **macOS only.** **VS Code engine floor `^1.90.0`** — every API used predates it.
- **Checks are plain `node` scripts** using `node:assert/strict`, ending in a single `console.log("OK: …")`. No framework. `scripts/subagents-check.mjs` is the pattern.
- **Every read is best-effort.** Nothing added here may throw, and in particular nothing may throw inside `deck.on("down")` — a press that raises is a dead daemon.
- **The extension is silent.** No logging, no notifications, on any path.
- **The daemon writes exactly one file** (`~/.claude/streamdeck-focus.json`). `~/.claude/streamdeck-windows/` is written by the *extension* and only read by the daemon. Do not add daemon writes there.
- **Comments explain why, not what**, naming the rejected alternative — match `src/sessions.mjs` and `src/index.mjs`.
- **State file shape:** `{ folders: string[], focused: boolean, activeSessionId: string|null }`, filename `<extension-host process.pid>.json`.
- **`POLL_MS = 400`** is the existing extension tick and is reused; no second timer.

## File Structure

| File | Responsibility |
|---|---|
| `src/sessions.mjs` | **Modify.** Export the existing `isAlive` so there is one definition of the signal-0 liveness trick, not two. |
| `src/window-state.mjs` | **Create.** Read the published window states, drop dead windows. Reader half of the reverse channel — its own module for the same reason `vscode-state.mjs` is: one best-effort external read per file. |
| `src/index.mjs` | **Modify.** `isRepeatPress` gains the window list and the new rule; the press handler passes it. |
| `extension/extension.js` | **Modify.** Publish state each tick; remember the revealed `Terminal`; unlink on deactivate. |
| `scripts/terminal-focus-check.mjs` | **Modify.** Cases for `readWindowStates` — liveness, corrupt files, non-JSON names. |
| `scripts/slots-check.mjs` | **Modify.** The press-semantics cases, including the assertion that inverts. |
| `CLAUDE.md` | **Modify.** The folder-match invariant (its premise expired) and the one-file invariant (a second file now exists that the daemon reads but does not write). |

---

### Task 1: Read published window state

**Files:**
- Modify: `src/sessions.mjs` (the `isAlive` declaration, ~line 66)
- Create: `src/window-state.mjs`
- Modify: `scripts/terminal-focus-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function isAlive(pid: number): boolean` from `src/sessions.mjs`
  - `export function readWindowStates(dir?: string): Array<{ pid: number, folders: string[], focused: boolean, activeSessionId: string|null }>` from `src/window-state.mjs`
  - `export function countVsCodeWindows(dir?: string): number` from `src/window-state.mjs`

**Why this is synchronous:** it is called from `deck.on("down")`, which is a synchronous event handler. An async read would resolve after the press had already been handled. It reads a handful of ~80-byte files, so `readdirSync`/`readFileSync` cost nothing measurable.

- [ ] **Step 1: Write the failing checks**

Append to `scripts/terminal-focus-check.mjs`, immediately before the version-match block near the end (the block whose comment begins "The extension's version tracks the daemon's"):

```js
// The reverse channel's reader. A window publishes state only while its
// extension host is alive, so the filename IS the liveness handle — no
// timestamps, no staleness window, no heartbeat writes.
const wdir = await mkdtemp(join(tmpdir(), "streamdeck-windows-check-"));
const winFile = (name, body) => writeFile(join(wdir, name), typeof body === "string" ? body : JSON.stringify(body));

// A live window: this very process, which is alive by definition.
await winFile(`${process.pid}.json`, {
  folders: ["/repo"],
  focused: true,
  activeSessionId: "sess-a",
});
// A window that crashed without unlinking. 999999 is above macOS's default
// pid_max, so it cannot be a running process and cannot be recycled onto one.
await winFile("999999.json", { folders: ["/gone"], focused: true, activeSessionId: "sess-x" });
// Caught mid-write, and a name that isn't a pid at all.
await winFile("truncated.json.tmp", "{\"folders\":[");
await winFile(`${process.pid + 0.5}.json`, { folders: ["/nope"] });
await winFile("notes.txt", "not json");

const live = readWindowStates(wdir);
assert.deepEqual(
  live.map((w) => w.folders[0]),
  ["/repo"],
  "only windows whose extension host is still alive count"
);
assert.equal(live[0].pid, process.pid);
assert.equal(live[0].focused, true);
assert.equal(live[0].activeSessionId, "sess-a");

// A state file that parses but lacks `folders` can't be matched to a window,
// so it is not a window. Guarded rather than assumed: this file is written by
// another process and a read can land mid-rewrite.
await winFile(`${process.pid}.json`, { focused: true, activeSessionId: "sess-a" });
assert.deepEqual(readWindowStates(wdir), [], "a state without folders is unusable, not a window");

// No directory at all — the extension has never run anywhere.
assert.deepEqual(readWindowStates(join(wdir, "missing")), []);

// How many VS Code windows are open at all, for the "N of M windows have the
// extension" line. JetBrains writes the same lock shape with its own ideName
// and must not inflate M — it can never run this extension.
const idedir = await mkdtemp(join(tmpdir(), "streamdeck-ide-check-"));
const lock = (name, body) => writeFile(join(idedir, name), JSON.stringify(body));
await lock("1.lock", { ideName: "Visual Studio Code", workspaceFolders: ["/a"] });
await lock("2.lock", { workspaceFolders: ["/b"] }); // no ideName — VS Code, same as focusWindow assumes
await lock("3.lock", { ideName: "PhpStorm", workspaceFolders: ["/c"] });
await writeFile(join(idedir, "notes.txt"), "ignored");
assert.equal(countVsCodeWindows(idedir), 2, "JetBrains windows can't run this extension and don't count");
assert.equal(countVsCodeWindows(join(idedir, "missing")), 0);

await rm(idedir, { recursive: true, force: true });
await rm(wdir, { recursive: true, force: true });
```

Add `writeFile` to the existing `node:fs/promises` import, and add:

```js
import { countVsCodeWindows, readWindowStates } from "../src/window-state.mjs";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run terminal-focus-check`
Expected: FAIL — `Cannot find module '.../src/window-state.mjs'`

- [ ] **Step 3: Export `isAlive` from sessions.mjs**

In `src/sessions.mjs`, change the declaration (currently `function isAlive(pid) {`) to:

```js
// Exported for window-state.mjs, which needs the same test on a different kind
// of pid — a VS Code extension host rather than a Claude process. One
// definition rather than two: signal 0 meaning "does this pid exist" is the
// kind of detail that gets re-derived subtly wrong.
export function isAlive(pid) {
```

Leave the body and its existing comment alone.

- [ ] **Step 4: Write `src/window-state.mjs`**

```js
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./sessions.mjs";

const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");

/**
 * What each open VS Code window can see, published by the extension: the
 * folders it has open, whether it's the focused window, and which session's
 * terminal is currently in front.
 *
 * This is the reverse of `terminal-focus.mjs` — the daemon asks for a terminal
 * there, and learns what actually happened here. The original design
 * deliberately had no reply channel, on the grounds that nothing consumed one;
 * the repeat-press rule now does, because "did this press change anything" is
 * only knowable inside the editor.
 *
 * **Synchronous on purpose.** The only caller is `deck.on("down")`, which is a
 * synchronous handler — an async read would resolve after the press was already
 * decided. These are a handful of ~80-byte files.
 *
 * **The filename is the liveness handle.** Each file is named for its extension
 * host's own pid, so a window that has gone away is detected exactly, with
 * `process.kill(pid, 0)`. The alternative was a timestamp plus a heartbeat
 * write, which would mean six open windows rewriting a file every 400ms
 * forever to say nothing changed.
 *
 * Every failure is skipped rather than thrown, same rule as `vscode-state.mjs`:
 * these files are written by another process and a read can land mid-write. A
 * missing directory just means the extension has never run.
 */
export function readWindowStates(dir = WINDOWS_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no directory — the extension has never run on this machine
  }

  const states = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -".json".length));
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, name), "utf8"));
      // Without `folders` there is no way to say which window this is, which
      // is the one thing the caller needs it for.
      if (!Array.isArray(state.folders)) continue;
      states.push({
        pid,
        folders: state.folders,
        focused: state.focused === true,
        activeSessionId: state.activeSessionId ?? null,
      });
    } catch {
      // mid-write or corrupt — skip this window, not the whole read
    }
  }
  return states;
}

const IDE_DIR = join(homedir(), ".claude", "ide");

/**
 * How many VS Code windows are open, from the IDE locks Claude Code writes.
 *
 * Only used for the "N of M windows have the extension" line the daemon logs:
 * the extension takes effect in a window only after that window has been
 * reloaded, and a window that silently behaves like the old build is the one
 * failure this feature reliably produces. Comparing this against
 * `readWindowStates().length` is the whole diagnostic.
 *
 * JetBrains writes the same lock shape with its own `ideName` and can never run
 * this extension, so counting it would permanently overstate the denominator
 * and make a fully-reloaded machine still look incomplete. A lock with no
 * `ideName` counts as VS Code — that's the same normalisation `focusWindow`
 * already applies, and it's the common case.
 */
export function countVsCodeWindows(dir = IDE_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    try {
      const { ideName } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if ((ideName ?? "Visual Studio Code") === "Visual Studio Code") count++;
    } catch {
      // mid-write or corrupt — not countable
    }
  }
  return count;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm run terminal-focus-check`
Expected: `OK: terminal focus`

Then confirm nothing that imports `sessions.mjs` regressed:

Run: `npm run slots-check && npm run title-check && npm run tasks-check && npm run subagents-check`
Expected: four `OK:` lines.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.mjs src/window-state.mjs scripts/terminal-focus-check.mjs
git commit -m "feat: read per-window state published by the extension"
```

---

### Task 2: The new press rule

**Files:**
- Modify: `src/index.mjs` — `isRepeatPress` (~line 336) and its docblock, the import block (~line 9), and the press handler (~line 905)
- Modify: `scripts/slots-check.mjs` (~lines 339-348)

**Interfaces:**
- Consumes: `readWindowStates` from Task 1.
- Produces: `isRepeatPress(previous, press, windows = [])` — `windows` is `readWindowStates()`'s return. The default of `[]` means "no extension anywhere", which resolves to today's folder rule.

**The assertion that inverts:** `scripts/slots-check.mjs:345` currently asserts *"a sibling session of the same project counts as the second press"*. That is the behaviour being removed. Its replacement must say why, or a future reader will assume the inversion was a mistake.

- [ ] **Step 1: Rewrite the press-semantics checks**

In `scripts/slots-check.mjs`, replace the six `isRepeatPress` assertions (the block starting `eq(isRepeatPress(null, p1), false, …)`) with:

```js
// Windows the extension is running in. `folders` is what ties a published
// window to a session; `activeSessionId` is the session whose terminal is
// actually in front, which is the fact the whole rule turns on.
const win = (folders, focused, activeSessionId) => ({ pid: 1, folders, focused, activeSessionId });
const onA = [win(["/repo"], true, "a")];

// No window state at all: nothing is running the extension, so the rule falls
// back to what it always did. This is the path every un-reloaded window takes,
// and it must stay exactly as it was.
eq(isRepeatPress(null, p1, []), false, "the first press of all focuses, never opens detail");
eq(isRepeatPress(p1, p1, []), true, "without the extension, the same key twice still opens detail");
eq(isRepeatPress(p1, p2, []), true, "without the extension, a sibling still counts as the second press");
eq(isRepeatPress(other, p1, []), false, "a key from another project breaks the chain");
eq(isRepeatPress(p1, empty, []), false, "an empty key has nothing to tell you about");
eq(isRepeatPress(empty, p1, []), false, "and pressing one breaks the chain rather than continuing it");

// With the extension running, the rule is "did this press change anything".
// A sibling press DOES change something — it switches to a different
// terminal — so it is a first press, not a second. This assertion is the exact
// inverse of the one above it, and deliberately so: matching on the folder was
// justified by every key in a project's block doing the identical thing, and
// terminal focus made that false.
eq(isRepeatPress(p1, p2, onA), false, "with the extension, a sibling switches terminals — a first press");
eq(isRepeatPress(p1, p1, onA), true, "the same session again, already in front and focused, opens detail");

// Both halves of "changed nothing" are required.
eq(isRepeatPress(p1, p1, [win(["/repo"], false, "a")]), false, "alt-tabbed away: the press raises the window instead");
eq(isRepeatPress(p1, p1, [win(["/repo"], true, "b")]), false, "another terminal was clicked by hand: switch back first");
eq(isRepeatPress(p1, p1, [win(["/repo"], true, null)]), false, "nothing revealed yet, so nothing to escalate from");

// A window that publishes state but doesn't hold this session's folder says
// nothing about it — that session's window has no extension, so folder rule.
eq(isRepeatPress(p1, p2, [win(["/elsewhere"], true, "a")]), true, "an unrelated window doesn't govern this project");

// Multi-root: the published folders are matched with matchFolder, so a session
// under an open folder resolves to that window rather than missing it.
eq(isRepeatPress(p1, p1, [win(["/", "/repo"], true, "a")]), true, "matchFolder picks the most specific published folder");

// TWO windows open on the same folder — live on this machine, per CLAUDE.md
// (11854.lock and 53173.lock both claim kob/kob-backend). Only the window that
// actually revealed the session can report it as active, so every candidate is
// asked rather than one being elected. Electing one with .find() would answer
// from whichever readdir happened to return first, and get it wrong half the
// time — permanently, for every session in that folder.
const twoWindows = [win(["/repo"], false, null), win(["/repo"], true, "a")];
eq(isRepeatPress(p1, p1, twoWindows), true, "the window that revealed it answers, whichever order they're read in");
eq(isRepeatPress(p1, p1, [...twoWindows].reverse()), true, "and read order must not change the answer");
eq(isRepeatPress(p1, p1, [win(["/repo"], false, null), win(["/repo"], false, "a")]), false,
   "still false when no matching window is both focused and showing it");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run slots-check`
Expected: FAIL — the first new assertion to break is `"with the extension, a sibling switches terminals — a first press"`, since the current implementation ignores its third argument and matches on folder.

- [ ] **Step 3: Rewrite `isRepeatPress`**

In `src/index.mjs`, replace the function and its docblock:

```js
/**
 * Does this press mean "tell me more" about the session it lands on?
 *
 * The rule is: a press escalates to the detail board only when it **changed
 * nothing**. If it had to switch you to a different terminal, that was a first
 * press, however many presses came before it.
 *
 * This used to match on the *folder* rather than the session, and that was
 * right at the time: a press could only raise a window, so every key in a
 * project's contiguous block did the identical thing and moving along the block
 * was the same gesture as pressing one key twice. Terminal focus falsified the
 * premise — pressing key A and key B now reveal two different terminals — and
 * the symptom was that a project's second session could not be reached at all,
 * because its key opened the detail board instead of its terminal.
 *
 * "Changed nothing" isn't knowable from out here: it needs the window's focus
 * state and which terminal is in front, both of which live inside the editor.
 * `windows` is what the extension publishes for exactly this. Inferring it
 * instead ("you pressed this session last, so its terminal must still be
 * showing") is one line and wrong in the two cases you'd notice — after
 * alt-tabbing away, and after clicking another terminal by hand.
 *
 * **Degradation is per window, not per machine.** A window that publishes no
 * state is not running the extension, whatever is installed on disk — on
 * 2026-08-16 the extension was installed and zero open windows were running it,
 * because none had been reloaded, so an install check would have said yes and
 * been useless. Such a window keeps the old folder rule, so reloading one
 * window changes that window and no other.
 */
export function isRepeatPress(previous, press, windows = []) {
  // An empty key can't start a chain (no session to tell you about) and,
  // having no folder, can't continue one.
  if (press.session_id === null || press.folder === null) return false;

  const matching = windows.filter((w) => matchFolder(press.folder, w.folders));
  // No extension in this session's window — today's rule, unchanged.
  if (matching.length === 0) return previous?.folder === press.folder;

  // Every candidate is asked, rather than one being elected with .find().
  // Two windows can have the same folder open — CLAUDE.md records exactly that
  // live on this machine — and electing one would answer from whichever
  // readdir returned first. Only the window that actually revealed the session
  // can report it active, so `.some` is self-disambiguating: it needs no way to
  // tell the windows apart, which is a problem this project has not solved.
  return (
    previous?.session_id === press.session_id &&
    matching.some((w) => w.focused && w.activeSessionId === press.session_id)
  );
}
```

`matchFolder` is **not** currently imported in `src/index.mjs`. Add it to the existing `./sessions.mjs` import on line 7, which becomes:

```js
import { getLiveSessions, matchFolder, readTaskList, taskWindow } from "./sessions.mjs";
```

Do **not** write a second folder-containment helper — `matchFolder` already settles exact-beats-ancestor and longest-ancestor-wins, and `slots-check` already covers it.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run slots-check`
Expected: `OK: project grouping`

- [ ] **Step 5: Wire it into the press handler**

Add to the `./window-state.mjs` import in `src/index.mjs`:

```js
import { readWindowStates } from "./window-state.mjs";
```

Change the press handler line (currently `const isRepeat = isRepeatPress(lastPress, press);`) to:

```js
    // Read per press, not cached on the poll: which terminal is in front can
    // change between two presses, and a 2s-stale answer is exactly the wrong
    // one when the question is "did anything just change".
    const isRepeat = isRepeatPress(lastPress, press, readWindowStates());
```

- [ ] **Step 6: Log how many windows are actually running the extension**

The one failure this feature reliably produces is a window that was never reloaded and so silently behaves like the old build. It cost a full debugging session on 2026-08-16, when the extension was installed, `code --list-extensions` said yes, and **zero** open windows were running it. After this change the two states stop being distinguishable by eye — a stale window opens the detail board on a sibling press, a reloaded one switches terminals, and both look like working software.

Add to the import from `./window-state.mjs`:

```js
import { countVsCodeWindows, readWindowStates } from "./window-state.mjs";
```

Inside `run()`, beside the other loop-local state (near `let lastPress = null;`):

```js
  // Last logged "N of M windows have the extension", so the line is printed
  // when it changes rather than every 2s. Logged on change and not only at
  // startup because the number changes as you reload windows, and that is
  // exactly the moment the feedback is worth having — a startup-only message
  // would need a daemon restart to tell you the reload worked.
  let lastCoverage = null;
```

In the poll loop's `else` branch (the sessions board — the one that calls `refresh`), after the existing `attentionCount = await drawAttention(...)` line:

```js
        const withExt = readWindowStates().length;
        const total = countVsCodeWindows();
        const coverage = `${withExt}/${total}`;
        if (coverage !== lastCoverage) {
          lastCoverage = coverage;
          console.log(
            withExt === total
              ? `terminal focus: ${coverage} windows have the extension`
              : `terminal focus: ${coverage} windows have the extension — reload the rest (Developer: Reload Window)`
          );
        }
```

- [ ] **Step 7: Verify the daemon still loads and nothing regressed**

Run: `node --check src/index.mjs && node -e "import('./src/index.mjs').then(() => console.log('imports clean, no daemon started'))"`
Expected: `imports clean, no daemon started`

Run: `npm run slots-check && npm run terminal-focus-check && npm run title-check && npm run tasks-check && npm run subagents-check && npm run colors-check`
Expected: six `OK:` lines.

- [ ] **Step 8: Commit**

```bash
git add src/index.mjs scripts/slots-check.mjs
git commit -m "feat: escalate to detail only when a press changed nothing"
```

---

### Task 3: The extension publishes state

**Files:**
- Modify: `extension/extension.js`

**Interfaces:**
- Consumes: the file shape `readWindowStates` expects — `{ folders: string[], focused: boolean, activeSessionId: string|null }` at `~/.claude/streamdeck-windows/<process.pid>.json`.
- Produces: nothing the daemon calls.

**The one non-obvious part:** `activeSessionId` is derived by **object identity**, not by pid. The extension already knows which `Terminal` it revealed and which `sessionId` asked for it. Comparing `vscode.window.activeTerminal` against the remembered object answers "is that still what's in front" with no pid chain crossing the channel — which is what lets the daemon decide a press synchronously, with no `ps` call.

- [ ] **Step 1: Extend the imports and module state**

In `extension/extension.js`, replace the `node:fs` import line and add constants and state below the existing ones:

```js
const { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
```

After the `REQUEST_MAX_MS` constant:

```js
// Where this window publishes what it can see, for the daemon to read when it
// decides what a key press means. Named for this extension host's own pid, so
// the daemon can tell a live window from a crashed one exactly
// (`process.kill(pid, 0)`) instead of guessing from a timestamp.
const WINDOWS_DIR = join(homedir(), ".claude", "streamdeck-windows");
const STATE_FILE = join(WINDOWS_DIR, `${process.pid}.json`);
```

After the `busy` declaration:

```js
// The terminal this window last revealed, and the session that asked for it.
// Kept as the Terminal *object*: comparing it against window.activeTerminal is
// how we answer "is that session still in front" without any pid involved.
let revealed = null;
// Last JSON written, so an unchanged state costs no write. Six open windows on
// a 400ms tick would otherwise be fifteen writes a second saying nothing
// changed.
let lastState = null;
```

- [ ] **Step 2: Record what was revealed**

In `tick`, at the `terminal.show()` call, record it first:

```js
        // Remembered so publishState can answer "is this session's terminal
        // still the one in front" by object identity.
        revealed = { terminal, sessionId: request.sessionId ?? null };
        // Not show(true): the point of the press is to put you in this
        // terminal, so taking keyboard focus is the feature, not a side effect.
        // This also activates the terminal's tab group, which is what brings a
        // joined split forward with the right pane active.
        terminal.show();
        // Publish immediately rather than waiting for the next tick. The
        // daemon reads this to decide whether the *next* press changed
        // anything, and the interval calls publishState() before tick(), so
        // leaving it to the timer would report this reveal a full tick late —
        // up to ~800ms after the press. A second press inside that window
        // would read a stale `activeSessionId`, conclude the press changed
        // something, and re-reveal instead of opening the detail board:
        // the double-press the whole rule is named after would be the one
        // gesture that didn't work. show() has also just taken focus, so this
        // captures the corrected `focused` at the same time.
        publishState();
        return;
```

- [ ] **Step 3: Add `publishState`**

Add above `activate`:

```js
// Publish what this window can see. Synchronous and cheap; the daemon reads it
// from a synchronous key-press handler, so there is nothing to await on either
// end.
//
// Silent on every failure, like everything else here: this runs in every open
// window several times a second, and a window that can't write has nothing
// useful to say about it.
function publishState() {
  try {
    const activeSessionId =
      revealed && vscode.window.activeTerminal === revealed.terminal ? revealed.sessionId : null;
    const state = JSON.stringify({
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      focused: vscode.window.state.focused,
      activeSessionId,
    });
    if (state === lastState) return;
    mkdirSync(WINDOWS_DIR, { recursive: true });
    writeFileSync(STATE_FILE, state);
    // Set only after a successful write, so a failed one is retried next tick
    // rather than remembered as done.
    lastState = state;
  } catch {
    // unwritable ~/.claude, window closing mid-write — nothing to say
  }
}
```

- [ ] **Step 4: Call it, and clean up on the way out**

Replace `activate` and `deactivate`:

Note `publishState` is declared with `function`, so it is hoisted and `tick` can call it from above its definition.

```js
// Sweep state files whose extension host is gone. A window that crashes or is
// force-quit never runs deactivate(), and the daemon's liveness check only
// asks "does a process with this pid exist" — which stops meaning "that window
// exists" as soon as macOS recycles the number onto something unrelated. The
// daemon would then trust a frozen `focused`/`activeSessionId` from a window
// that died weeks ago.
//
// Done here rather than in the daemon on purpose: the daemon must not delete
// files it did not write, and a window opening or reloading is frequent enough
// that nothing survives long enough for a pid to come back around.
function reapDeadWindows() {
  try {
    for (const name of readdirSync(WINDOWS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const pid = Number(name.slice(0, -".json".length));
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try {
        process.kill(pid, 0); // alive — leave it alone
      } catch {
        try {
          unlinkSync(join(WINDOWS_DIR, name));
        } catch {
          // raced with another window's sweep, or not ours to delete
        }
      }
    }
  } catch {
    // directory doesn't exist yet — nothing to sweep
  }
}

function activate() {
  reapDeadWindows();
  // Two independent concerns on one timer rather than two: publishing is
  // synchronous and must run on every tick, while tick() is async and guards
  // itself with `busy`, so a slow request pass must not also stall publishing.
  //
  // tick() can reject past its own try/catches: `await terminal.processId` on
  // a terminal disposed mid-iteration, or `request.pids` on a parsed `null`
  // (valid JSON, e.g. the literal `null`, but not an object). Either would
  // otherwise surface as an unhandled rejection — a stray Extension Host
  // warning — on every window that doesn't own the terminal, on every
  // request, which is the opposite of the silent no-match this is meant to be.
  timer = setInterval(() => {
    publishState();
    tick().catch(() => {});
  }, POLL_MS);
}

function deactivate() {
  clearInterval(timer);
  // A window that closes cleanly takes its state file with it. One that
  // crashes leaves an ~80-byte orphan, which the daemon's liveness check
  // ignores forever — cheaper than a reaper, and the daemon must not delete
  // files it did not write.
  try {
    unlinkSync(STATE_FILE);
  } catch {
    // never written, or already gone
  }
}
```

- [ ] **Step 5: Verify it parses and installs**

Run: `node --check extension/extension.js`
Expected: no output.

Run: `npm run ext:install`
Expected: the install line plus the reload reminder.

Run: `npm run terminal-focus-check`
Expected: `OK: terminal focus` — the version-match assertion still holds.

- [ ] **Step 6: Commit**

```bash
git add extension/extension.js
git commit -m "feat: publish window focus and active terminal from the extension"
```

---

### Task 4: Documentation and acceptance

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Rewrite the repeat-press invariant**

In `CLAUDE.md`'s invariants section, the bullet beginning **"A second press means 'tell me more'"** contains this justification:

> **The match is on the folder, not the key**: a project's sessions sit in one
> contiguous block, so moving along that block is the same gesture as pressing
> one key twice — either way you're already looking at that project. Matching
> the key instead made a two-session project need a press on one specific key
> of the pair, which is exactly the muscle-memory detail the board is meant to
> remove.

Replace that passage with:

```markdown
  **The match is on the session, and on whether the press changed anything.**
  It used to be on the folder, justified by every key in a project's block
  doing the identical thing — moving along the block was the same gesture as
  pressing one key twice. **Terminal focus falsified that**: key A and key B now
  reveal two different terminals, so B is a new first press, not a repeat of A.
  The symptom was that a project's second session was unreachable — its key
  opened the detail board instead of its terminal, which is the one thing the
  extension exists to do.
  "Changed anything" is not knowable out here, so `readWindowStates` reads it
  from what the extension publishes: the window's focus and which session's
  terminal is in front. Inferring it instead ("you pressed this session last,
  so its terminal must still be showing") is one line and wrong in the two
  cases you would actually notice — after alt-tabbing away, and after clicking
  another terminal by hand.
  **A window that publishes nothing keeps the old folder rule**, so degradation
  is per window rather than per machine. Do not replace that with a check for
  whether the extension is *installed*: on 2026-08-16 it was installed and zero
  open windows were running it, because none had been reloaded since — the
  install check would have answered yes and been useless. A live state file
  proves the thing that matters, which is that *this* window is running it.
```

- [ ] **Step 2: Add the module bullet**

After the `src/terminal-focus.mjs` bullet in the architecture list, add:

```markdown
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
```

- [ ] **Step 3: Amend the one-file invariant**

In the **"Read-only, two install steps"** invariant, after the sentence naming `~/.claude/streamdeck-focus.json`, add:

```markdown
  There is a second file in this feature and the daemon does **not** write it:
  `~/.claude/streamdeck-windows/<pid>.json` is published by the extension and
  only read here. Keep it that way — a daemon that deletes files it did not
  write is a worse trade than the occasional orphan a crashed window leaves,
  which the liveness check ignores anyway.
```

- [ ] **Step 4: Update the README's known limit**

In `README.md`'s `## Known limits`, the bullet about terminal focus needing the extension gains a sentence, since the extension now changes more than terminal reveal:

```markdown
  Without it, a second press on any key of a project opens the detail board;
  with it, pressing a *different* session's key switches to that terminal and
  only a repeat press on the same session opens detail. Windows reloaded and
  not-yet-reloaded therefore behave differently until every window has been
  reloaded once.
```

- [ ] **Step 5: Run every check**

Run: `for c in render slots usage stats title tasks subagents colors terminal-focus; do npm run --silent $c-check || break; done`
Expected: nine `OK:` lines.

- [ ] **Step 6: Manual acceptance**

Requires the deck, and a VS Code window **reloaded after Task 3's `ext:install`**. In the `claude-streamdeck` window with two Claude sessions:

1. Press session A's key twice — detail opens on the second press. **Do this once slowly and once as a fast double-tap**; both must open detail. The fast one is what the `publishState()` call after `show()` exists for.
2. Press A, then B — B's terminal comes forward, **no detail board**. This is the bug being fixed.
3. Press B again — detail opens for B.
4. Press A, alt-tab to another app, press A — the window is raised, no detail.
5. Press A, click B's terminal by hand, press A — A's terminal returns, no detail.
6. In a window **not** reloaded since install, press two sibling keys — old behaviour, detail on the second press.
7. Quit VS Code entirely and reopen — `ls ~/.claude/streamdeck-windows/` shows no file for a dead pid. Then force-quit one window (`kill -9` its extension host, so `deactivate` never runs), confirm its file is left behind, reload any other window, and confirm the orphan is gone — that is `reapDeadWindows` doing the job that stops pid reuse resurrecting it.
8. Watch the daemon's output while reloading windows one at a time: `terminal focus: N/M windows have the extension` should count up, printing only when it changes, and drop the "reload the rest" tail once N === M.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: the repeat-press rule now turns on what the press changed"
```

---

## Self-Review

**Spec coverage:** every amendment section maps to a task — the published state shape and object-identity derivation (T3.1-3.3), pid-keyed filename and write-on-change (T3.1, T3.3), unlink on deactivate (T3.4), the reader with liveness (T1.4), `matchFolder` reuse and the three-step rule (T2.3), per-window degradation (T2.3 plus its checks in T2.1), both amended invariants (T4.1, T4.3), and all seven manual acceptance items (T4.6). The amendment's "Install cost: none" needed no task.

**Placeholder scan:** no TBDs; every code step carries the actual code; the two prose replacements in T4 quote the exact text they replace.

**Pushback findings folded in** (see the spec's "Pushback review, 2026-08-16"): the publish lag is closed by calling `publishState()` right after `terminal.show()` in T3.2, with a fast double-tap added to acceptance in T4.6; the duplicate-folder election is replaced by `filter`+`some` in T2.3 with its own checks in T2.1; stale-window visibility is the coverage log in T2.6, backed by `countVsCodeWindows` in T1.4 and its checks in T1.1; pid reuse is closed by `reapDeadWindows` in T3.4, with a force-quit case in T4.6.

**Type consistency:** `readWindowStates(dir?)` returns `{pid, folders, focused, activeSessionId}` in T1 and is consumed under those exact names in T2's `win()` helper and in `isRepeatPress`. `countVsCodeWindows(dir?)` returns a number in T1.4 and is called in T2.6. The file shape written in T3.3 matches what T1.4 parses field for field. `isAlive` is exported in T1.3 and imported in T1.4. `isRepeatPress(previous, press, windows = [])` is defined in T2.3 and called with three arguments in T2.5. `publishState` is declared with `function` in T3.3 so T3.2's earlier call site is hoisted, and `reapDeadWindows` in T3.4 uses `readdirSync`/`unlinkSync`, both added to the import in T3.1.

**One deliberate ordering note:** Task 2 ships a rule that reads state nothing writes yet, so between Task 2 and Task 3 every window falls back to the folder rule — today's behaviour. That is the correct intermediate state, not a broken one, and it is why the tasks can be reviewed independently.
