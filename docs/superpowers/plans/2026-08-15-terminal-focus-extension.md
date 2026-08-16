# Terminal Focus Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing a session key on the Stream Deck reveals that session's terminal inside its VS Code window — the joined split group comes forward with the right pane active, or the right terminal tab is selected.

**Architecture:** The daemon writes one request file naming the session's ancestor pid chain. A tiny VS Code extension in every window polls that file and calls `terminal.show()` on the terminal whose `processId` is in the chain; every other window finds no match and does nothing. The request is self-routing — no ports, no auth token, no window addressing.

**Tech Stack:** Node ESM (daemon side, no new dependencies), plain CommonJS JavaScript (extension side, no build step, no dependencies), `ps` for the process table.

**Spec:** `docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md`

## Global Constraints

- **No new runtime dependencies.** The daemon's `dependencies` stay `@elgato-stream-deck/node` and `sharp`. The extension has no dependencies at all and no build step.
- **Node ESM with `.mjs`** on the daemon side (`"type": "module"`); **CommonJS `.js`** in `extension/`, because that is what the VS Code extension host loads without a bundler.
- **macOS only.** `ps -Ao pid,ppid` and `~/.vscode/extensions` are assumed.
- **VS Code engine floor `^1.90.0`.** Every API used (`window.terminals`, `Terminal.processId`, `Terminal.show`) predates it by years.
- **Checks are plain `node` scripts** using `node:assert/strict`, `process.exit(1)` on mismatch via a thrown assertion, ending with a `console.log("OK: …")`. No framework, no runner. Follow `scripts/subagents-check.mjs` exactly.
- **Every read and every write is best-effort.** Anything that can fail returns/skips rather than throwing — the rule already stated for `src/vscode-state.mjs` and `src/sessions.mjs`. A failure here must degrade to today's behaviour: window raised, terminal untouched.
- **Comments explain why, not what.** Match the density and voice of the surrounding modules.
- **Request file:** `~/.claude/streamdeck-focus.json`, shape `{ pids: number[], sessionId: string|null, ts: number }`.
- **Extension identity:** name `claude-streamdeck-terminal-focus`, publisher `wouterkobeco`, installed to `~/.vscode/extensions/claude-streamdeck-terminal-focus`.
- **Constants:** `POLL_MS = 400`, `REQUEST_MAX_MS = 5000`, `ancestorChain` default `maxDepth = 20`.

## File Structure

| File | Responsibility |
|---|---|
| `src/terminal-focus.mjs` | **Create.** The whole daemon side: `ancestorChain` (pure), `parseProcessTable` (pure), `requestFocus` (runs `ps`, writes the file). Its own module rather than more lines in `index.mjs` — same shape as `vscode-state.mjs`, which is also "one best-effort external lookup for the press path". |
| `scripts/terminal-focus-check.mjs` | **Create.** Covers `ancestorChain`, `parseProcessTable`, and the press-ordering guard. |
| `src/sessions.mjs` | **Modify.** One line: carry `pid` through on the returned session. |
| `src/index.mjs` | **Modify.** `focusWindow` takes the session and fires `requestFocus`. Two call sites updated. |
| `extension/package.json` | **Create.** Manifest. No build, no deps. |
| `extension/extension.js` | **Create.** ~45 lines: poll, match, `show()`. |
| `extension/README.md` | **Create.** What it is and that it is installed by `npm run ext:install`. |
| `package.json` | **Modify.** Two scripts: `terminal-focus-check`, `ext:install`. |
| `CLAUDE.md` | **Modify.** Commands list, architecture bullets, the press-path diagram, and the "near-zero-install" invariant. |
| `README.md` | **Modify.** The install step and what it buys. |

---

### Task 1: `ancestorChain` and `parseProcessTable`

The two pure functions, with their check. Nothing touches the daemon yet, so this task is complete and reviewable on its own.

**Files:**
- Create: `src/terminal-focus.mjs`
- Create: `scripts/terminal-focus-check.mjs`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function ancestorChain(pid: number, ppidByPid: Map<number, number>, maxDepth = 20): number[]`
  - `export function parseProcessTable(stdout: string): Map<number, number>`

- [ ] **Step 1: Write the failing check**

Create `scripts/terminal-focus-check.mjs`:

```js
// Verifies the pid-ancestry walk that matches a Claude session to the VS Code
// terminal running it: Terminal.processId is the shell, and claude is a
// descendant of it, so the chain from claude upwards is what the extension
// matches against.
// Run: node scripts/terminal-focus-check.mjs
import assert from "node:assert/strict";
import { ancestorChain, parseProcessTable } from "../src/terminal-focus.mjs";

// The real shape, from the roadmap doc's own measurement:
//   99684 claude  <-  92021 zsh  <-  2433 ptyHost  <-  1316 Code  <-  1
const real = new Map([
  [99684, 92021],
  [92021, 2433],
  [2433, 1316],
  [1316, 1],
]);

// The whole chain, claude first, stopping before pid 1 — the terminal's shell
// (92021) has to be in here or nothing matches.
assert.deepEqual(ancestorChain(99684, real), [99684, 92021, 2433, 1316]);

// A pid the table doesn't know: the process died between the registry read and
// the `ps` call. Its own pid is still worth sending — it just won't match.
assert.deepEqual(ancestorChain(4242, real), [4242]);

// Reaching pid 1 ends the walk, and 1 itself is never included: it is every
// process's ancestor, so matching on it would match every terminal.
assert.deepEqual(ancestorChain(1316, real), [1316]);
assert.deepEqual(ancestorChain(1, real), []);

// A corrupt table that claims a cycle must terminate rather than hang. `ps`
// can't really produce one, which is exactly why it would never be noticed.
assert.deepEqual(ancestorChain(5, new Map([[5, 6], [6, 5]])), [5, 6]);

// maxDepth is the backstop for a cycle the seen-check somehow misses.
const deep = new Map(Array.from({ length: 100 }, (_, i) => [i + 2, i + 3]));
assert.equal(ancestorChain(2, deep, 20).length, 20);

// `ps -Ao pid,ppid` output: a header line, leading whitespace on right-aligned
// columns, and a trailing newline. All three have to survive parsing.
const table = parseProcessTable("  PID  PPID\n99684 92021\n  92021  2433\n 2433 1316\n");
assert.equal(table.get(99684), 92021);
assert.equal(table.get(2433), 1316);
assert.equal(table.size, 3);

// A blank or garbage line is skipped, not stored as NaN.
assert.equal(parseProcessTable("  PID  PPID\n\nnonsense\n7 8\n").size, 1);

console.log("OK: terminal focus");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/terminal-focus-check.mjs`
Expected: FAIL — `Cannot find module '.../src/terminal-focus.mjs'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/terminal-focus.mjs`:

```js
/**
 * The daemon half of terminal focus: work out which terminal a session is
 * running in, and ask for it.
 *
 * The join is process ancestry. `Terminal.processId` in the VS Code extension
 * API is the shell's pid; the session registry gives Claude's pid; Claude is a
 * descendant of that shell:
 *
 *   99684 claude  <-  92021 zsh  <-  2433 ptyHost  <-  1316 Code
 *
 * So the daemon sends the whole chain and the extension picks the terminal
 * whose processId is in it. Nothing here assumes a depth, a shell, or a
 * wrapper — the alternative, matching `Terminal.name`, tracks the terminal's
 * creation name rather than the OSC title Claude sets, and would break the
 * moment a terminal is renamed.
 */

/**
 * Every pid from `pid` up to (but not including) pid 1.
 *
 * Pure, and exported for the check, because this is the piece where being
 * subtly wrong is invisible: an off-by-one that drops the shell's own pid
 * matches nothing, and looks identical to "the extension isn't installed".
 *
 * Stops on three things: reaching pid 1 (whose inclusion would match every
 * terminal, since it is every process's ancestor), a pid the table doesn't
 * know (the process exited between the registry read and the `ps` call), and
 * a pid already seen. That last one can't happen with a real process table —
 * which is why it's guarded rather than assumed, along with `maxDepth` behind
 * it. A daemon that hangs on a press is worse than one that focuses nothing.
 */
export function ancestorChain(pid, ppidByPid, maxDepth = 20) {
  const chain = [];
  let current = pid;
  while (chain.length < maxDepth && current > 1 && !chain.includes(current)) {
    chain.push(current);
    const parent = ppidByPid.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return chain;
}

/**
 * `ps -Ao pid,ppid` output as pid -> ppid. The columns are right-aligned, so
 * every line has leading whitespace and a plain `split(" ")` would produce
 * empty fields; the first line is a header and the last is empty. Anything
 * that doesn't parse as two integers is skipped rather than stored as NaN.
 */
export function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of stdout.split("\n").slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
  }
  return table;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node scripts/terminal-focus-check.mjs`
Expected: `OK: terminal focus`

- [ ] **Step 5: Register the check**

In `package.json`, add to `"scripts"` after `"colors-check"`:

```json
    "terminal-focus-check": "node scripts/terminal-focus-check.mjs",
```

Verify: `npm run terminal-focus-check` prints `OK: terminal focus`.

- [ ] **Step 6: Commit**

```bash
git add src/terminal-focus.mjs scripts/terminal-focus-check.mjs package.json
git commit -m "feat: pid-ancestry helpers for terminal focus"
```

---

### Task 2: `requestFocus` and the press-ordering guard

Writes the request file. The guard is the reason this is its own task: it is the fix for a race a code review caught, and it is the only part of the daemon side that a reviewer could reject independently.

**Files:**
- Modify: `src/terminal-focus.mjs`
- Modify: `scripts/terminal-focus-check.mjs`

**Interfaces:**
- Consumes: `ancestorChain`, `parseProcessTable` from Task 1.
- Produces: `export async function requestFocus(session, { path?, readProcessTable? }): Promise<void>` — `session` needs `.pid` and `.session_id`. Both options exist for the check; the daemon calls `requestFocus(session)` with neither.

**Why the injected `readProcessTable`:** the race being fixed is "two presses, the earlier one's `ps` finishes last". Real `ps` calls complete in whatever order they like, so a check using them proves nothing. Injecting a table-reader whose promise the check resolves by hand is the only way to make the failing order deterministic. It is one optional parameter, not a plugin system.

- [ ] **Step 1: Write the failing checks**

Append to `scripts/terminal-focus-check.mjs`, above the final `console.log`:

```js
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestFocus } from "../src/terminal-focus.mjs";

const dir = await mkdtemp(join(tmpdir(), "streamdeck-focus-check-"));
const path = join(dir, "streamdeck-focus.json");
const read = async () => JSON.parse(await readFile(path, "utf8"));

// The happy path: the file names the chain, and the session id rides along so
// the file is readable when working out which press produced it.
await requestFocus({ pid: 99684, session_id: "sess-a" }, { path, readProcessTable: async () => real });
assert.deepEqual((await read()).pids, [99684, 92021, 2433, 1316]);
assert.equal((await read()).sessionId, "sess-a");
assert.ok(Date.now() - (await read()).ts < 5000);

// A session with no pid writes nothing at all rather than a request that can
// never match. Proven by the file still holding the previous press.
await requestFocus({ session_id: "sess-no-pid" }, { path, readProcessTable: async () => real });
assert.equal((await read()).sessionId, "sess-a");

// The race this guard exists for. Two presses; the *first* one's `ps` finishes
// *last*. Without the guard it overwrites the second and the deck reveals the
// terminal you already moved on from.
let releaseA, releaseB;
const tableA = new Promise((r) => (releaseA = r));
const tableB = new Promise((r) => (releaseB = r));
const pressA = requestFocus({ pid: 99684, session_id: "sess-a" }, { path, readProcessTable: () => tableA });
const pressB = requestFocus({ pid: 2433, session_id: "sess-b" }, { path, readProcessTable: () => tableB });
releaseB(real);
await pressB;
releaseA(real);
await pressA;
assert.equal((await read()).sessionId, "sess-b", "the newest press must win regardless of ps completion order");

// A `ps` that throws leaves the previous request alone and does not reject —
// the window is already being raised, this only decorates the press.
await requestFocus(
  { pid: 99684, session_id: "sess-c" },
  { path, readProcessTable: async () => { throw new Error("ps failed"); } }
);
assert.equal((await read()).sessionId, "sess-b");

await rm(dir, { recursive: true, force: true });
```

Move the existing `console.log("OK: terminal focus");` to the end of the file, and move the two new `import` lines up with the others at the top (Node hoists imports, but a check that reads top-to-bottom is the point of these files).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run terminal-focus-check`
Expected: FAIL — `The requested module '../src/terminal-focus.mjs' does not provide an export named 'requestFocus'`

- [ ] **Step 3: Write the implementation**

Add to the top of `src/terminal-focus.mjs`, below the module docblock:

```js
import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");

// Press order, captured synchronously at every call. See requestFocus.
let issued = 0;
```

And append to the same file:

```js
async function psTable() {
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid"], { maxBuffer: 8 * 1024 * 1024 });
  return parseProcessTable(stdout);
}

/**
 * Ask whichever VS Code window owns this session's terminal to reveal it.
 *
 * Self-routing: one file, read by every window's extension, acted on by the
 * single one that finds a matching `Terminal.processId`. The alternative — a
 * port file per window plus an HTTP POST — buys a delivery confirmation the
 * deck has nowhere to display, in exchange for three more ways to address the
 * wrong window.
 *
 * `issued` is the fix for a real race, not a theoretical one. This is fired
 * without `await` from the press handler and spawns a process before it
 * writes, so two presses 400ms apart can have their `ps` calls complete out of
 * order — and the *earlier* press would land last, revealing the terminal you
 * just moved on from. Taking the number before the first `await` records press
 * order rather than completion order, which is why the extension needs no
 * ordering logic of its own: this file only ever holds the newest press.
 *
 * Written to a temp file and renamed, because rename is atomic within a
 * filesystem and a reader polling on its own clock will otherwise eventually
 * catch a half-written file. (It would recover — a torn JSON read fails to
 * parse and the next tick retries — but rename costs nothing and removes the
 * case. The temp name carries `mine` so two writers can never share one.)
 *
 * Every failure is swallowed: the window is already being raised by the time
 * this runs, and a press that reveals no terminal is exactly today's product.
 *
 * `path` and `readProcessTable` exist for `terminal-focus-check`; the daemon
 * passes neither.
 */
export async function requestFocus(session, { path = FOCUS_FILE, readProcessTable = psTable } = {}) {
  if (!session?.pid) return;
  const mine = ++issued;
  try {
    const table = await readProcessTable();
    if (mine !== issued) return; // a newer press was issued while ps ran
    const tmp = `${path}.${mine}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({
        pids: ancestorChain(session.pid, table),
        sessionId: session.session_id ?? null,
        ts: Date.now(),
      })
    );
    await rename(tmp, path);
  } catch {
    // ps unavailable, ~/.claude unwritable, session gone — all best-effort
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run terminal-focus-check`
Expected: `OK: terminal focus`

- [ ] **Step 5: Commit**

```bash
git add src/terminal-focus.mjs scripts/terminal-focus-check.mjs
git commit -m "feat: write terminal focus requests, newest press wins"
```

---

### Task 3: Wire it into the press path

**Files:**
- Modify: `src/sessions.mjs:469-479` (the `matched.push({...})` literal)
- Modify: `src/index.mjs:9` (imports), `src/index.mjs:157-167` (`focusWindow`), `src/index.mjs:849`, `src/index.mjs:879`

**Interfaces:**
- Consumes: `requestFocus` from Task 2.
- Produces: sessions returned by `getLiveSessions()` now carry `pid: number`. `focusWindow(session)` replaces `focusWindow(folder, ide)`.

- [ ] **Step 1: Carry the pid on the session**

`getLiveSessions()` already reads `s.pid` — it calls `isAlive(s.pid)` at `sessions.mjs:466` — and then drops it. In the `matched.push({...})` literal, add it after `folder`:

```js
      folder: match.folder,
      // Claude's own pid, kept for terminal-focus.mjs: the VS Code terminal
      // running this session is the one whose shell is an ancestor of it.
      // Already read just above for the liveness check.
      pid: s.pid,
```

Subagent pseudo-sessions spread `...s` and so inherit their parent's pid. Leave that alone — subagents hold no board key, so no press ever reaches one.

- [ ] **Step 2: Verify nothing regressed**

Run: `npm run slots-check && npm run tasks-check && npm run title-check && npm run subagents-check`
Expected: four `OK:` lines. These import `sessions.mjs`; an added field must not disturb them.

- [ ] **Step 3: Change `focusWindow` to take the session**

In `src/index.mjs`, extend the import on line 9's neighbours:

```js
import { requestFocus } from "./terminal-focus.mjs";
```

Change the signature and body. `focusWindow(folder, ide)` becomes:

```js
async function focusWindow(session) {
  const { folder, ide } = session;
  const app = ide ?? "Visual Studio Code";
  const file = (app === "Visual Studio Code" ? await openFileIn(folder) : null) ?? (await anchorFile(folder));
  // Reveal the session's own terminal inside the window we're about to raise.
  // Not awaited: the two are independent, and a press must not wait on a `ps`
  // call to raise its window.
  //
  // Gated on `app`, not on `ide` — a lock file without an `ideName` yields
  // `ide === null` for a perfectly ordinary VS Code window, so gating on the
  // raw field would silently disable this for most sessions. `app` is the
  // normalised name the line above already computes for exactly this reason.
  if (app === "Visual Studio Code") requestFocus(session);
  if (!file) {
    console.error(`focus failed for ${folder}: no file found to open`);
    return;
  }
  execFile("open", ["-a", app, file], (err, _stdout, stderr) => {
    if (err) console.error(`focus failed for ${folder}:`, stderr || err.message);
  });
}
```

Note the `requestFocus` call sits *above* the `!file` early return: a window with no openable file can still have its terminal revealed, and the two failures are unrelated.

Add to the docblock above `focusWindow`, after the existing paragraph about alternatives:

```
// Raising the window is only half of it when several sessions share one: the
// terminal that's showing may be someone else's. `requestFocus` asks the
// window's own extension to reveal the right one — see
// docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md. It is
// a no-op without the extension installed, which is why it's fired and
// forgotten rather than checked.
```

- [ ] **Step 4: Update both call sites**

`src/index.mjs:849` (the attention-board exit press):

```js
      if (btn?.assigned) focusWindow(btn.assigned);
```

`src/index.mjs:879` (the normal session press, covering both first and repeat press):

```js
    if (btn?.assigned) focusWindow(btn.assigned);
```

Verify no others remain: `grep -n "focusWindow(" src/index.mjs` must show exactly three lines — the definition and those two.

- [ ] **Step 5: Verify the daemon still starts and presses still focus**

Run: `npm start` with the Stream Deck plugged in. Press a session key. Expected: its VS Code window is raised, exactly as before. `cat ~/.claude/streamdeck-focus.json` now shows a pid chain whose first entry matches that session's `pid` in `~/.claude/sessions/`. Nothing reads the file yet, so the terminal does not change.

Stop the daemon.

- [ ] **Step 6: Commit**

```bash
git add src/sessions.mjs src/index.mjs
git commit -m "feat: request terminal focus on every session key press"
```

---

### Task 4: The extension

**Files:**
- Create: `extension/package.json`
- Create: `extension/extension.js`
- Create: `extension/README.md`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: the request file written by Task 2 — `{ pids: number[], sessionId: string|null, ts: number }` at `~/.claude/streamdeck-focus.json`.
- Produces: nothing the daemon reads. The extension is a sink.

**Why plain JS and no packaging:** this is a private, single-machine, macOS-only tool that is never published. TypeScript would add a compile step and `@vscode/vsce` would add a dependency and an interactive packaging prompt, both to produce a `.vsix` that only ever gets installed locally. VS Code loads any directory under `~/.vscode/extensions/` that has a valid `package.json`, so a `cp -R` is the entire install. Step 1 proves that before anything is built on top of it.

- [ ] **Step 1: Prove a hand-copied extension loads at all**

This is the one assumption in the plan that a wrong answer would invalidate several steps of, so it gets retired first with the smallest possible extension.

Create `extension/package.json`:

```json
{
  "name": "claude-streamdeck-terminal-focus",
  "displayName": "Claude Stream Deck terminal focus",
  "description": "Reveals the terminal of the Claude Code session whose Stream Deck key was pressed.",
  "version": "1.0.0",
  "publisher": "wouterkobeco",
  "private": true,
  "license": "ISC",
  "categories": ["Other"],
  "engines": { "vscode": "^1.90.0" },
  "extensionKind": ["ui"],
  "activationEvents": ["onStartupFinished"],
  "main": "./extension.js",
  "contributes": {}
}
```

`extensionKind: ["ui"]` matters: in a remote (SSH) window the extension host runs on the *remote* machine by default, where `~/.claude/streamdeck-focus.json` is a different machine's file and terminal pids are remote pids no local `ps` will ever match. `ui` pins it to the local side.

Create a throwaway `extension/extension.js`:

```js
const vscode = require("vscode");

function activate() {
  console.log("claude-streamdeck-terminal-focus: activated");
}

module.exports = { activate, deactivate() {} };
```

Install and check:

```bash
rm -rf "$HOME/.vscode/extensions/claude-streamdeck-terminal-focus"
cp -R extension "$HOME/.vscode/extensions/claude-streamdeck-terminal-focus"
```

Open a **scratch** VS Code window (not one with work in it). Run `Developer: Reload Window`. Then `Developer: Show Running Extensions` — `Claude Stream Deck terminal focus` must be listed. If it is not, check `Help > Toggle Developer Tools > Console` for a manifest error.

**If it does not load**, stop and report before continuing: the fallback is `npx @vscode/vsce package` plus `code --install-extension`, which changes this task's install step and the `ext:install` script but nothing else in the plan.

- [ ] **Step 2: Write the real extension**

Replace `extension/extension.js` entirely:

```js
// Reveals the terminal of the Claude Code session whose Stream Deck key was
// pressed. The daemon (claude-streamdeck) writes one request file naming the
// session's ancestor pid chain; every VS Code window runs this and the single
// one that owns a terminal whose shell is in that chain reveals it. The rest
// find no match and do nothing — the request routes itself, so there is no
// port, no token, and no window addressing to get wrong.
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const vscode = require("vscode");

const FOCUS_FILE = join(homedir(), ".claude", "streamdeck-focus.json");
const POLL_MS = 400;
// A request older than this is ignored, so a window that was closed when the
// key was pressed doesn't act on it whenever it next opens.
const REQUEST_MAX_MS = 5000;

let timer = null;
// The last raw file contents seen. Change detection is on the bytes, not on
// the timestamp: `ts > lastTs` would assume a monotonic wall clock, which
// Date.now() is not, so an NTP correction could drop real presses or accept
// stale ones. Comparing contents assumes nothing about clocks.
let lastRaw = null;
// Set for the duration of a match pass. `Terminal.processId` is a Thenable, so
// a pass can outlive its own 400ms tick; without this, a slow pass for an old
// request could resolve *after* a fast pass for a new one and reveal the
// terminal that was pressed first.
let busy = false;

async function tick() {
  if (busy) return;

  let raw;
  try {
    raw = readFileSync(FOCUS_FILE, "utf8");
  } catch {
    return; // no request has ever been written, or it's unreadable
  }
  if (raw === lastRaw) return;
  // Claimed before the age check, so a stale request is rejected once rather
  // than re-read and re-rejected on every tick for as long as it sits there.
  lastRaw = raw;

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return; // caught mid-write; the next distinct read picks it up
  }
  if (!Array.isArray(request.pids) || Date.now() - request.ts > REQUEST_MAX_MS) return;

  busy = true;
  try {
    for (const terminal of vscode.window.terminals) {
      const pid = await terminal.processId;
      // Belt to `busy`'s braces: if a newer request landed while that resolved,
      // this pass is answering a question nobody is asking any more.
      if (raw !== lastRaw) return;
      if (request.pids.includes(pid)) {
        // Not show(true): the point of the press is to put you in this
        // terminal, so taking keyboard focus is the feature, not a side effect.
        // This also activates the terminal's tab group, which is what brings a
        // joined split forward with the right pane active.
        terminal.show();
        return;
      }
    }
    // No match: this session's terminal lives in another window, or its
    // ancestry is broken (tmux, screen, a reparented process). Silent by
    // design — every other window reaches here on every request.
  } finally {
    busy = false;
  }
}

function activate() {
  timer = setInterval(tick, POLL_MS);
}

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate };
```

- [ ] **Step 3: Add the install script**

In the root `package.json` `"scripts"`, after `"terminal-focus-check"`:

```json
    "ext:install": "rm -rf \"$HOME/.vscode/extensions/claude-streamdeck-terminal-focus\" && cp -R extension \"$HOME/.vscode/extensions/claude-streamdeck-terminal-focus\"",
```

- [ ] **Step 4: Write the extension README**

Create `extension/README.md`:

```markdown
# Claude Stream Deck terminal focus

Reveals the terminal of the Claude Code session whose Stream Deck key was
pressed — the joined split group comes forward with the right pane active, or
the right terminal tab is selected.

Install with `npm run ext:install` from the repository root, then run
`Developer: Reload Window` in each VS Code window that is already open. New
windows pick it up on their own.

No commands, no settings, nothing to configure. It polls
`~/.claude/streamdeck-focus.json` every 400ms and acts only when that file
names a terminal this window owns.

Design: `../docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md`
```

- [ ] **Step 5: Install and verify end to end**

```bash
npm run ext:install
```

Reload the scratch window, then in it start a Claude session in a terminal. Start the daemon (`npm start`) and press that session's key.

Expected: the terminal panel opens (if hidden) on that session's terminal, and it takes focus.

If nothing happens, check in order: `~/.claude/streamdeck-focus.json` exists and its `ts` is recent; `Developer: Show Running Extensions` lists the extension; `Help > Toggle Developer Tools > Console` shows no error from it.

- [ ] **Step 6: Commit**

```bash
git add extension package.json
git commit -m "feat: VS Code extension revealing a pressed session's terminal"
```

---

### Task 5: Acceptance and documentation

The feature is only verifiable on real hardware in real windows, so the acceptance run is a task rather than a footnote — and the two invariants this changes have to be written down in the same commit that makes them true.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Run the acceptance list**

With the daemon running and the extension installed, in order. Record any failure and stop rather than continuing past it.

1. **Joined split.** One window, two Claude sessions split into one group. Press each key: the group comes forward and the pressed session's pane becomes active.
2. **Separate tabs.** One window, two Claude sessions in separate terminal tabs. Press each key: the correct tab is selected.
3. **Hidden panel.** Hide the terminal panel. Press a key: the panel opens on the right terminal.
4. **Two windows.** One Claude session in each. Press each key: only the right window's terminal changes; the other window is untouched.
5. **Fast double press.** Press two *different* session keys in quick succession. The terminal that ends up revealed is the second one, every time. This is the press-ordering race — the failure most likely to survive into shipping, because it only shows under fast input.
6. **No `ideName`.** A session whose `~/.claude/ide/*.lock` has no `ideName` (so `session.ide` is `null`): the terminal is still revealed. This is the gate bug the spec review caught; it would otherwise fail silently for most sessions.
7. **Non-VS Code IDE.** Press a key for a JetBrains session: the window is raised and nothing else changes.
8. **No extension.** In a window that has not been reloaded since install, press a key: the window is raised, the terminal is untouched, no error anywhere.
9. **Daemon killed mid-press.** No orphaned state; a leftover `~/.claude/streamdeck-focus.json` is inert once older than 5s.

- [ ] **Step 2: Update the CLAUDE.md commands list**

In the fenced command block at the top, after `colors-check`:

```
npm run terminal-focus-check # pid-ancestry walk + newest-press-wins guard
npm run ext:install    # copy extension/ into ~/.vscode/extensions (reload windows after)
```

- [ ] **Step 3: Update the CLAUDE.md architecture diagram and module list**

In the ASCII diagram, replace the button-press line:

```
button press → index.mjs → vscode-state.mjs (already-open file) → `open -a "Visual Studio Code"`
                        ↘ terminal-focus.mjs → ~/.claude/streamdeck-focus.json → extension/ → terminal.show()
```

Add a module bullet after the `src/vscode-state.mjs` one:

```markdown
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
- `extension/` — the other half, ~45 lines of plain CommonJS with no build step
  and no dependencies, installed by copying it into `~/.vscode/extensions`.
  Polls the request file every 400ms and calls `terminal.show()`, which
  activates the terminal's tab group — that is what brings a joined split
  forward with the right pane active. `extensionKind: ["ui"]` is required, not
  cosmetic: in a remote window the extension host runs remotely, where the
  request file is another machine's and the terminal pids are remote pids.
```

- [ ] **Step 4: Amend the two invariants this changes**

Under "Invariants worth knowing before changing things", replace the **Read-only, near-zero-install** bullet's first sentence with:

```markdown
- **Read-only, near-two-install.** No hooks, no `settings.json` writes, no
  config file. The daemon reads from `~/.claude/`, VS Code's storage and the
  usage endpoint, and writes exactly one file: `~/.claude/streamdeck-focus.json`,
  the terminal-focus request. An earlier hook-based version was deleted; don't
  reintroduce one.
```

And add a new invariant after the "One install step, in the status line" one:

```markdown
- **The second install step is the extension, and it needs a window reload.**
  `npm run ext:install` copies `extension/` into `~/.vscode/extensions`; windows
  already open when it lands do not have it until `Developer: Reload Window`.
  Terminals survive that reload (`terminal.integrated.enablePersistentSessions`
  defaults on, and ptyHost is a separate process holding the `claude` processes
  up), but prove it on a scratch window before doing it to one with real work in
  it. A window without the extension simply doesn't reveal terminals — never
  make its absence an error, same rule as the status line's context file.
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
```

- [ ] **Step 5: Update the README**

Three places. First, a new subsection at the end of `## Setup` — after the
status-line block ending at `README.md:116`, before `## Where the data comes
from` at `README.md:117`:

```markdown
### Reveal the right terminal (optional)

Raising a window is only half the job when several sessions share it — the
terminal showing may be another session's. A small VS Code extension in this
repo fixes that: pressing a key reveals that session's terminal, bringing a
joined split group forward with the right pane active.

```
npm run ext:install
```

Then run `Developer: Reload Window` in each VS Code window that is already
open; new windows pick it up on their own. Without it, everything else works
exactly as before — the window is raised and the terminal is left alone.
```

Second, in `## Checks` (`README.md:134`), add the new check to the list in the
same format the existing entries use:

```markdown
- `npm run terminal-focus-check` — the pid-ancestry walk that matches a session
  to its terminal, and the guard that makes the newest key press win when two
  land at once.
```

Third, in `## Known limits` (`README.md:152`), add the regression honestly
rather than leaving it for someone to hit:

```markdown
- With **two windows open on the same folder**, a press can raise one window
  while revealing the terminal in the other. The extension routes by process id
  and gets it right; the window raise opens a file and macOS picks the window.
  Nothing outside the editor can aim that raise at a specific window.
```

- [ ] **Step 6: Run every check**

Run: `for c in render slots usage stats title tasks subagents colors terminal-focus; do npm run $c-check || break; done`
Expected: nine `OK:` lines, no failure.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: terminal focus extension, and the two invariants it changes"
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — `sessions.mjs` pid (T3.1), `terminal-focus.mjs` both functions (T1, T2), `index.mjs` gate on the normalized `app` (T3.3), the extension with both reentrancy guards and content-change detection (T4.2), temp-file-plus-rename (T2.3), the check including the ordering race (T2.1), all ten manual acceptance items (T5.1), and both invariant amendments plus the duplicate-folder regression (T5.4). The spec's security note needed no task — it asserts no new boundary and adds no code.

**Deviations from the spec, both simplifications:** the spec left the extension's language open and implied a `.vsix` build; this plan uses plain CommonJS and a `cp -R`, removing TypeScript, `@vscode/vsce` and the packaging step, with Task 4 Step 1 retiring the risk that a hand-copied extension doesn't load. The spec also proposed a `CLAUDE_DIR` override for testability; this plan passes `path` as an option instead, so no module reads an environment variable that exists only for tests.

**Type consistency:** `ancestorChain(pid, ppidByPid, maxDepth)`, `parseProcessTable(stdout)`, `requestFocus(session, { path, readProcessTable })` are named identically in every task that uses them. The request file's three fields (`pids`, `sessionId`, `ts`) are written in T2.3 and read in T4.2 under the same names. `session.pid` is added in T3.1 and consumed in T2.3 via T3.3.
