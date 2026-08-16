# Remote SSH Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session running in a VS Code Remote-SSH window gets a key on the deck, carrying everything a local key carries except the context gauge.

**Architecture:** `sessions.mjs` derives every path from one constant, so the host-dependent surface is three things, not a filesystem abstraction: a `root`, an `isAlive`, and a `tail`. Small files (`sessions/`, `ide/`, `tasks/`, subagent `.meta.json`) arrive as a tar stream and land in a scratch tree that is replaced wholesale on every fetch; transcripts never touch local disk and arrive as length-prefixed tails. Nothing runs on the remote but a POSIX shell — the daemon already computes every path it needs.

**Tech Stack:** Node 20+ ESM, no new dependencies. `node:child_process` for `ssh`/`tar`, `node:assert/strict` for checks. The VS Code extension stays plain CommonJS with no build step.

**Spec:** `docs/superpowers/specs/2026-08-16-remote-ssh-sessions-design.md`

## Global Constraints

- **No new npm dependencies.** `ssh` and `tar` are invoked as subprocesses.
- **Nothing may throw into the poll loop.** Every reader added here returns an empty/`null` result on failure, matching `vscode-state.mjs` and `window-state.mjs`.
- **`window-state.mjs` stays synchronous.** Its only caller is `deck.on("down")`.
- **Host strings are pinned to `/^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/`** and passed to `ssh` after `--`. A leading `-` is the specific hazard.
- **Remote paths never enter a command string.** They go over stdin, one per line.
- **Checks are plain `node scripts/*-check.mjs`** using `node:assert/strict`, exiting non-zero on mismatch. No framework. No check may open an SSH connection.
- **The extension's version tracks the daemon's** — `terminal-focus-check` enforces it. Bumping one means bumping `package.json` too. This release is **1.1.22 → 1.1.23** (patch).
- **`TAIL_BYTES` is 65536** and must stay the single source of that number.
- **Spec A only.** Pressing a remote key (spec B) and the context gauge (spec C) are out of scope; `ctx/` is not fetched and process ancestry is not fetched.

---

### Task 1: Host validation and publication

The join key. The extension knows which host a window is on; nothing else does.

**Files:**
- Modify: `extension/extension.js:111-129` (`publishState`)
- Modify: `extension/package.json:5` (version)
- Modify: `package.json:3` (version)
- Modify: `src/window-state.mjs:33-69` (`readWindowStates`)
- Create: `scripts/remote-check.mjs`
- Modify: `package.json` scripts (add `remote-check`)

**Interfaces:**
- Consumes: nothing.
- Produces: `validHost(value) -> string | null` exported from `src/window-state.mjs`. `readWindowStates()` entries gain `host: string | null`.

- [ ] **Step 1: Write the failing check**

Create `scripts/remote-check.mjs`:

```js
// Verifies the remote-SSH source: host validation, the two fetch framings,
// and that a remote source produces byte-identical sessions to a local one.
// Run: node scripts/remote-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindowStates, validHost } from "../src/window-state.mjs";

// --- validHost ------------------------------------------------------------
assert.equal(validHost("192.168.2.6"), "192.168.2.6", "a plain host passes");
assert.equal(validHost("pi@192.168.2.6"), "pi@192.168.2.6", "user@host passes");
assert.equal(validHost("beast.local"), "beast.local", "a dotted name passes");
// A leading dash is an ssh *option*, not a host: `-oProxyCommand=...` would
// run locally. execFile does not help — the parsing is ssh's own.
assert.equal(validHost("-oProxyCommand=curl evil|sh"), null, "a leading dash is rejected");
assert.equal(validHost("host; rm -rf /"), null, "shell metacharacters are rejected");
assert.equal(validHost("host name"), null, "a space is rejected");
assert.equal(validHost(""), null, "empty is rejected");
assert.equal(validHost(undefined), null, "absent is null, not a throw");
assert.equal(validHost(42), null, "a non-string is null, not a throw");

// --- readWindowStates carries host ---------------------------------------
const dir = await mkdtemp(join(tmpdir(), "streamdeck-remote-check-"));
await writeFile(
  join(dir, `${process.pid}.json`),
  JSON.stringify({ folders: ["/home/pi/x"], focused: false, activeSessionId: null, host: "192.168.2.6" })
);
const [win] = readWindowStates(dir);
assert.equal(win.host, "192.168.2.6", "a published host is returned");

const dir2 = await mkdtemp(join(tmpdir(), "streamdeck-remote-check-"));
await writeFile(
  join(dir2, `${process.pid}.json`),
  JSON.stringify({ folders: ["/x"], focused: false, activeSessionId: null, host: "-oProxyCommand=x" })
);
assert.equal(readWindowStates(dir2)[0].host, null, "a hostile host is dropped, the window is kept");

const dir3 = await mkdtemp(join(tmpdir(), "streamdeck-remote-check-"));
await writeFile(join(dir3, `${process.pid}.json`), JSON.stringify({ folders: ["/x"], focused: true }));
assert.equal(readWindowStates(dir3)[0].host, null, "a window with no host reads null, not undefined");

console.log("remote-check: OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL with `SyntaxError: The requested module '../src/window-state.mjs' does not provide an export named 'validHost'`

- [ ] **Step 3: Implement `validHost` and thread it through `readWindowStates`**

In `src/window-state.mjs`, above `readWindowStates`:

```js
/**
 * A host string safe to hand to `ssh` as an argument.
 *
 * Every other field this file returns is consumed as data — `folders` is
 * checked for being strings only because a non-string would throw inside
 * `folder.endsWith`, in a synchronous press handler. `host` is different in
 * kind: it is *executed*. A value beginning with `-` is taken by `ssh` as an
 * option, so `-oProxyCommand=…` would run a command on this machine, and
 * `execFile` does not help because the parsing is ssh's own. The daemon also
 * passes it after `--`; this is the other half of that pair.
 *
 * Deliberately narrower than the set of legal hostnames. A host this rejects
 * is a host you can add to `~/.ssh/config` under a plain alias.
 */
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validHost(value) {
  return typeof value === "string" && HOST_RE.test(value) ? value : null;
}
```

In the `states.push({...})` call, add:

```js
        host: validHost(state.host),
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/remote-check.mjs`
Expected: `remote-check: OK`

- [ ] **Step 5: Publish `host` from the extension**

In `extension/extension.js`, above `publishState`:

```js
// The host half of a Remote-SSH window's identity, for the daemon's own ssh.
//
// A window carries a single remote authority — local and remote folders cannot
// be mixed in one window — so folder 0 is representative rather than arbitrary.
// The agreement is asserted anyway: it costs nothing and catches the day that
// stops being true.
//
// Only the plain `ssh-remote+<host>` form is understood. Dev containers and WSL
// encode their authority as hex JSON (`dev-container+7b22686f7374…`), which is
// a remote kind this feature does not support and must never reach `ssh`.
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sshHost(folders) {
  if (vscode.env.remoteName !== "ssh-remote" || !folders.length) return null;
  const authorities = new Set(folders.map((f) => f.uri.authority));
  if (authorities.size !== 1) return null;
  const [authority] = authorities;
  if (!authority.startsWith("ssh-remote+")) return null;
  const host = authority.slice("ssh-remote+".length);
  return HOST_RE.test(host) ? host : null;
}
```

In `publishState`, replace the `state` assignment:

```js
    const folders = vscode.workspace.workspaceFolders ?? [];
    const state = JSON.stringify({
      folders: folders.map((f) => f.uri.fsPath),
      focused: vscode.window.state.focused,
      activeSessionId,
      host: sshHost(folders),
    });
```

- [ ] **Step 6: Bump both versions**

`extension/package.json`: `"version": "1.1.23"`
`package.json`: `"version": "1.1.23"`

- [ ] **Step 7: Register the check**

In `package.json` scripts, after `"terminal-focus-check"`:

```json
    "remote-check": "node scripts/remote-check.mjs",
```

- [ ] **Step 8: Run the checks that cover what changed**

Run: `node scripts/remote-check.mjs && node scripts/terminal-focus-check.mjs`
Expected: both print OK. `terminal-focus-check` asserts the two versions match — it fails if only one was bumped.

- [ ] **Step 9: Commit**

```bash
git add extension/extension.js extension/package.json package.json src/window-state.mjs scripts/remote-check.mjs
git commit -m "feat: a remote window publishes the host it is on"
```

---

### Task 2: Fetch the tree and the pid list

**Files:**
- Create: `src/remote-fs.mjs`
- Modify: `scripts/remote-check.mjs`

**Interfaces:**
- Consumes: `validHost` from Task 1.
- Produces, from `src/remote-fs.mjs`:
  - `TREE_CMD` — the remote shell string for call 1.
  - `splitTreeStream(buffer) -> { pids: Set<number>, tar: Buffer }`
  - `sshArgs(host, controlPath) -> string[]`

- [ ] **Step 1: Write the failing check**

Append to `scripts/remote-check.mjs`, before the final `console.log`:

```js
// --- call 1 framing -------------------------------------------------------
import { sshArgs, splitTreeStream } from "../src/remote-fs.mjs";

const treeStream = Buffer.concat([
  Buffer.from("2187779\n1\n412\n---\n"),
  Buffer.from("TAR-BYTES-\x00\x01\x02"),
]);
const split = splitTreeStream(treeStream);
assert.deepEqual([...split.pids].sort((a, b) => a - b), [1, 412, 2187779], "pids parse");
assert.equal(split.tar.toString("binary"), "TAR-BYTES-\x00\x01\x02", "tar bytes survive the split byte-exact");

// A separator inside the tar payload must not re-split: only the first wins.
const twice = splitTreeStream(Buffer.from("7\n---\nA\n---\nB"));
assert.equal(twice.tar.toString(), "A\n---\nB", "only the first separator splits the stream");

// A host that answered nothing is empty, never a throw.
assert.deepEqual([...splitTreeStream(Buffer.alloc(0)).pids], [], "an empty stream has no pids");
assert.equal(splitTreeStream(Buffer.alloc(0)).tar.length, 0, "an empty stream has no tar");

// --- ssh argv -------------------------------------------------------------
const argv = sshArgs("192.168.2.6", "/tmp/cm/%r@%h:%p");
assert.equal(argv.at(-1), "192.168.2.6", "the host is the last argument");
assert.equal(argv.at(-2), "--", "the host is passed after --, so a dash cannot become an option");
assert.ok(argv.includes("BatchMode=yes"), "never prompts for a password");
assert.ok(argv.includes("ConnectTimeout=5"), "a dead host fails fast");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL — `Cannot find module '../src/remote-fs.mjs'`

- [ ] **Step 3: Implement the framing**

Create `src/remote-fs.mjs`:

```js
import { spawn } from "node:child_process";

// Where the pid list ends and the tar stream begins. Safe as a delimiter
// because everything before it is digits and newlines.
const SEPARATOR = "\n---\n";

/**
 * Call 1: this host's live pids, then its small files as a tar stream.
 *
 * `/proc` rather than `ps`, so nothing has to know which `ps` the host ships or
 * how it formats columns; `ps -A -o pid=` is the fallback for a remote without
 * `/proc`.
 *
 * **The member list is built positively with `find`, not by excluding a glob.**
 * Two facts force this, both measured against a real host:
 *
 * 1. `tar --exclude` matches with `fnmatch` and *no* `FNM_PATHNAME`, so `*`
 *    crosses `/`. `--exclude='projects/*​/*.jsonl'` therefore also drops
 *    `projects/<slug>/<id>/subagents/agent-*.jsonl` four levels down — the
 *    files `readRunningSubagents` reads. Nothing errors; remote sessions simply
 *    never show a subagent again. The anchored BRE below cannot do this:
 *    `[^/]*` provably does not cross `/`.
 * 2. Excluding only the *live* sessions' transcripts is not enough. A project
 *    directory holds every transcript it has ever had — this host carries a
 *    4.3MB one from a session that ended days ago. The rule has to be "no
 *    depth-2 transcript", not "not these ones".
 *
 * Measured on the live host: 20KB with this list, 4.7MB without it.
 *
 * Subagent transcripts ride along in the tar, with their real mtimes — which
 * `readRunningSubagents` needs, since `SUBAGENT_IDLE_MAX_S` retires an agent
 * that stopped writing. That is why they are not fetched as tails instead.
 *
 * A missing `~/.claude` exits 0 with an empty stream rather than failing: a host
 * you have opened a window on but never run Claude Code on is an ordinary state,
 * not an error.
 */
export const TREE_CMD =
  "cd ~/.claude 2>/dev/null || exit 0; " +
  "{ ls /proc 2>/dev/null || ps -A -o pid= 2>/dev/null; } | grep -E '^[0-9]+$'; " +
  "echo ---; " +
  "{ find sessions ide tasks -type f 2>/dev/null; " +
  '  find projects -type f 2>/dev/null | grep -v "^projects/[^/]*/[^/]*\\.jsonl$"; ' +
  "} | tar -cf - -T - 2>/dev/null";

/**
 * Split call 1's stream into the pid set and the tar bytes.
 *
 * Only the *first* separator splits: the tar payload is arbitrary binary and
 * can contain the same three bytes. Anything unparseable yields empties — this
 * runs against another machine's output on a link that can drop.
 */
export function splitTreeStream(buffer) {
  const at = buffer.indexOf(SEPARATOR);
  if (at < 0) return { pids: new Set(), tar: Buffer.alloc(0) };
  const pids = new Set();
  for (const line of buffer.subarray(0, at).toString("utf8").split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return { pids, tar: buffer.subarray(at + SEPARATOR.length) };
}

/**
 * Arguments for every call to a host.
 *
 * `ControlMaster`/`ControlPersist` are what make this affordable: a cold
 * connection is ~600ms, a warm multiplexed one ~20ms. `BatchMode` guarantees it
 * never blocks on a passphrase prompt in a daemon with no terminal.
 *
 * The host goes last and after `--`. `validHost` already rejects a leading
 * dash; this is the second half of that guard, because a host that reached ssh
 * as `-oProxyCommand=…` would run a command on *this* machine.
 */
export function sshArgs(host, controlPath) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=60",
    "--",
    host,
  ];
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/remote-check.mjs`
Expected: `remote-check: OK`

- [ ] **Step 5: Commit**

```bash
git add src/remote-fs.mjs scripts/remote-check.mjs
git commit -m "feat: frame the remote tree fetch, pids then tar"
```

---

### Task 3: Fetch transcript tails

Transcripts never reach local disk. `whole` is transported as a fact rather than reconstructed from a byte offset — a wrong `whole` makes `startedEmpty` fire and a busy remote session reads `CLEAR`.

**Files:**
- Modify: `src/remote-fs.mjs`
- Modify: `scripts/remote-check.mjs`

**Interfaces:**
- Consumes: nothing from Task 2 beyond the module.
- Produces, from `src/remote-fs.mjs`:
  - `TAILS_CMD` — the remote shell string for call 2.
  - `parseTails(buffer, paths) -> Map<string, { lines: string[], whole: boolean }>`

- [ ] **Step 1: Write the failing check**

Append to `scripts/remote-check.mjs`, before the final `console.log`:

```js
// --- call 2 framing -------------------------------------------------------
import { parseTails } from "../src/remote-fs.mjs";

// A short file: the declared size is the whole file, so `whole` is true and
// absence in the lines is absence in the file.
const short = Buffer.from("6\na\nb\n");
const shortOut = parseTails(short, ["/p/a.jsonl"]);
assert.deepEqual(shortOut.get("/p/a.jsonl"), { lines: ["a", "b", ""], whole: true }, "a short file is whole");

// A long file: 65536 bytes sent, a larger size declared. `whole` must be false
// even though the payload is exactly the tail window — this is the case that
// makes startedEmpty lie if it is got wrong.
const body = "x".repeat(65536);
const long = Buffer.concat([Buffer.from("233880\n"), Buffer.from(body)]);
assert.equal(parseTails(long, ["/p/b.jsonl"]).get("/p/b.jsonl").whole, false, "a truncated tail is not whole");

// Exactly at the boundary: 65536 bytes is still the whole file.
const exact = Buffer.concat([Buffer.from("65536\n"), Buffer.from(body)]);
assert.equal(parseTails(exact, ["/p/c.jsonl"]).get("/p/c.jsonl").whole, true, "65536 bytes exactly is whole");

// Several files in one stream, read in the order they were asked for.
const many = Buffer.concat([Buffer.from("2\nA\n"), Buffer.from("2\nB\n")]);
const manyOut = parseTails(many, ["/p/x.jsonl", "/p/y.jsonl"]);
assert.deepEqual(manyOut.get("/p/x.jsonl").lines, ["A", ""], "the first file's bytes stop at its declared size");
assert.deepEqual(manyOut.get("/p/y.jsonl").lines, ["B", ""], "the second file starts where the first ended");

// wc -c pads on some systems.
assert.equal(parseTails(Buffer.from("      2\nA\n"), ["/p/z.jsonl"]).get("/p/z.jsonl").whole, true, "a padded count parses");

// A missing file reports 0 and consumes nothing.
const missing = parseTails(Buffer.from("0\n2\nB\n"), ["/p/gone.jsonl", "/p/y.jsonl"]);
assert.deepEqual(missing.get("/p/gone.jsonl"), { lines: [], whole: false }, "a missing file is unknown, not empty");
assert.deepEqual(missing.get("/p/y.jsonl").lines, ["B", ""], "and the next file still parses");

// A truncated stream yields unknown for what never arrived.
const cut = parseTails(Buffer.from("5\nab"), ["/p/cut.jsonl"]);
assert.deepEqual(cut.get("/p/cut.jsonl"), { lines: [], whole: false }, "a stream that stopped mid-file is unknown");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL — `parseTails is not a function`

- [ ] **Step 3: Implement the tail framing**

Append to `src/remote-fs.mjs`:

```js
// Kept in step with sessions.mjs's TAIL_BYTES. Both describe the same window.
const TAIL_BYTES = 65536;

/**
 * Call 2: the true byte size of each transcript, then its last 64KB.
 *
 * Paths arrive on **stdin, one per line**, and are never interpolated into this
 * string. A cwd with a space or an apostrophe in it is an ordinary thing to
 * have, and would otherwise split the loop or unbalance a quote; the malicious
 * reading of the same hole is secondary to the accidental one.
 *
 * **The paths are relative to `~/.claude`, which is why the `cd` is here.** A
 * path read from stdin is data, and `~` is not expanded inside `"$f"` — sending
 * `~/.claude/projects/…` would make every `wc` and `tail` miss, and every remote
 * session would silently lose its title. `cd` once, send relative paths.
 *
 * `wc -c` before `tail` is the frame *and* the answer to `whole`: the size is
 * the file's, the payload is at most the tail window, and the two together say
 * whether the window reached byte 0. Reconstructing that here from a byte offset
 * is what this design exists to avoid.
 */
export const TAILS_CMD =
  "cd ~/.claude 2>/dev/null || exit 0; " +
  'while IFS= read -r f; do wc -c < "$f" 2>/dev/null || echo 0; tail -c 65536 "$f" 2>/dev/null; done';

/**
 * Read call 2's stream back into one `{ lines, whole }` per requested path, in
 * the order they were requested.
 *
 * Shaped to match `tailLines` exactly, including its failure value: a read that
 * failed reports `{ lines: [], whole: false }` — unknown, not empty. A stream
 * that stopped early leaves every remaining path unknown for the same reason.
 */
export function parseTails(buffer, paths) {
  const out = new Map();
  let at = 0;
  for (const path of paths) {
    const nl = buffer.indexOf("\n", at);
    if (nl < 0) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    const size = Number(buffer.subarray(at, nl).toString("utf8").trim());
    at = nl + 1;
    if (!Number.isInteger(size) || size <= 0) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    const expected = Math.min(size, TAIL_BYTES);
    const body = buffer.subarray(at, at + expected);
    if (body.length < expected) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    at += expected;
    out.set(path, { lines: body.toString("utf8").split("\n"), whole: size <= TAIL_BYTES });
  }
  return out;
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/remote-check.mjs`
Expected: `remote-check: OK`

- [ ] **Step 5: Commit**

```bash
git add src/remote-fs.mjs scripts/remote-check.mjs
git commit -m "feat: transport a transcript tail with its true size"
```

---

### Task 4: The three injection points in `sessions.mjs`

The heart of it. After this task a remote source produces the same sessions as a local one from the same bytes — asserted, not assumed.

**Files:**
- Modify: `src/sessions.mjs:5-10` (dir constants), `:90-96` (`transcriptPathFor`, `projectDirFor`), `:319` (`readRunningSubagents`), `:459-466` (`readContext`), `:488-593` (`getLiveSessions`)
- Modify: `scripts/remote-check.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/sessions.mjs`:
  - `localSource(root?) -> { host: null, root: string, isAlive: (pid: number) => boolean, tail: (path: string) => Promise<{lines: string[], whole: boolean}> }`
  - `getLiveSessions(sources?: Source[])` — defaults to `[localSource()]`, unchanged for every existing caller.
  - Every returned session gains `host: string | null`.
  - `transcriptPathFor({cwd, sessionId}, root?)` and `readRunningSubagents(dir, tail?)` gain optional trailing parameters; existing calls are unaffected.
  - `tailLines` becomes **exported**. `remote-fs.mjs`'s injected `tail` falls back to it for subagent transcripts, which ride in the tar and are read off the fetched tree like any local file.

- [ ] **Step 1: Write the failing check**

Append to `scripts/remote-check.mjs`, before the final `console.log`:

```js
// --- one body, two sources ------------------------------------------------
// The whole point of the design: a remote source is the same code reading the
// same bytes. Build one fixture tree, read it as local, then read it again as a
// "remote" source whose tail and isAlive are canned, and require the two to
// agree on everything but `host`.
import { mkdir } from "node:fs/promises";
import { getLiveSessions, localSource, transcriptPathFor } from "../src/sessions.mjs";

const fx = await mkdtemp(join(tmpdir(), "streamdeck-remote-fixture-"));
await mkdir(join(fx, "sessions"), { recursive: true });
await mkdir(join(fx, "ide"), { recursive: true });
const SID = "3afa50c6-168d-4a35-8448-dcb2350d1bff";
const CWD = "/home/pi/domotica/dom-setup";
await writeFile(
  join(fx, "sessions", "2187779.json"),
  JSON.stringify({
    pid: process.pid, // alive for the local source
    sessionId: SID,
    cwd: CWD,
    kind: "interactive",
    entrypoint: "cli",
    name: "dom-setup-2d",
    status: "idle",
    statusUpdatedAt: 1786879076976,
  })
);
await writeFile(
  join(fx, "ide", "39433.lock"),
  JSON.stringify({ workspaceFolders: [CWD], ideName: "Visual Studio Code" })
);
const transcript = transcriptPathFor({ cwd: CWD, sessionId: SID }, fx);
await mkdir(join(transcript, ".."), { recursive: true });
const aiTitleLine = JSON.stringify({ type: "assistant", aiTitle: "wiring the relay board" });
await writeFile(transcript, aiTitleLine + "\n");

const localOut = await getLiveSessions([localSource(fx)]);
assert.equal(localOut.length, 1, "the fixture yields exactly one session");
assert.equal(localOut[0].host, null, "a local session carries no host");

const remoteSource = {
  host: "192.168.2.6",
  root: fx,
  isAlive: (pid) => pid === process.pid,
  tail: async () => ({ lines: [aiTitleLine, ""], whole: true }),
};
const remoteOut = await getLiveSessions([remoteSource]);
assert.equal(remoteOut.length, 1, "the same tree read as remote yields the same one session");
assert.equal(remoteOut[0].host, "192.168.2.6", "a remote session carries its host");
assert.deepEqual(
  { ...remoteOut[0], host: null },
  { ...localOut[0], host: null },
  "a remote source and a local source cannot disagree about a session"
);

// isAlive is per source: a remote pid must never be checked against this
// machine's process table.
const deadRemote = await getLiveSessions([{ ...remoteSource, isAlive: () => false }]);
assert.deepEqual(deadRemote, [], "a pid absent from the host's list drops the session");

// Two sources at once, which is the daemon's real shape.
const both = await getLiveSessions([localSource(fx), remoteSource]);
assert.equal(both.length, 2, "sources concatenate");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL — `does not provide an export named 'localSource'`

- [ ] **Step 3: Make the paths take a root**

In `src/sessions.mjs`, replace lines 5-10:

```js
const CLAUDE_DIR = join(homedir(), ".claude");
const TAIL_BYTES = 65536;
```

(Delete `IDE_DIR`, `SESSIONS_DIR`, `TASKS_DIR`, `CTX_DIR`, `PROJECTS_DIR`; `TAIL_BYTES` keeps its existing position and value.)

Replace `transcriptPathFor`/`projectDirFor` (lines 90-96):

```js
export function transcriptPathFor({ cwd, sessionId }, root = CLAUDE_DIR) {
  return join(projectDirFor(cwd, root), `${sessionId}.jsonl`);
}

function projectDirFor(cwd, root = CLAUDE_DIR) {
  return join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
```

- [ ] **Step 4: Make the two remaining readers take what they need**

`readRunningSubagents` (line 319) gains an injected tail:

```js
export async function readRunningSubagents(dir, tail = tailLines) {
```

and inside it, every `await tailLines(path)` becomes `await tail(path)`.

`readContext` (line 459) gains a root:

```js
async function readContext(sessionId, root) {
  try {
    const { context } = JSON.parse(await readFile(join(root, "ctx", `${sessionId}.json`), "utf8"));
    return typeof context === "number" ? context : null;
  } catch {
    return null;
  }
}
```

`readTaskProgress` (line 427) and the task-list reader at line 402 take a root the same way: `join(root, "tasks", sessionId)` in place of `join(TASKS_DIR, sessionId)`.

- [ ] **Step 5: Split `getLiveSessions` into a per-source body**

Replace the `export async function getLiveSessions() {` signature (line 488) and add the source factory above it:

```js
/**
 * The local machine as a source: today's behaviour, named.
 *
 * A source is the whole host-dependent surface of this module — where the tree
 * is, whether a pid is alive, and how a transcript tail is read. Every path here
 * derives from one root, so those three are all a remote host needs to supply;
 * everything between them is this file, unchanged, which is the point. See
 * docs/superpowers/specs/2026-08-16-remote-ssh-sessions-design.md.
 */
export function localSource(root = CLAUDE_DIR) {
  return { host: null, root, isAlive, tail: tailLines };
}

export async function getLiveSessions(sources = [localSource()]) {
  return (await Promise.all(sources.map(sessionsFrom))).flat();
}

async function sessionsFrom(source) {
```

Inside `sessionsFrom`, apply the three substitutions and stamp the host:

- `readJsonFiles(SESSIONS_DIR)` → `readJsonFiles(join(source.root, "sessions"))`
- `readJsonFiles(IDE_DIR, [".lock"])` → `readJsonFiles(join(source.root, "ide"), [".lock"])`
- `if (!isAlive(s.pid)) continue;` → `if (!source.isAlive(s.pid)) continue;`
- in the `matched.push({...})` object, add `host: source.host,`
- `projectDirFor(s.cwd)` → `projectDirFor(s.cwd, source.root)`
- `readRunningSubagents(dir)` → `readRunningSubagents(dir, source.tail)`
- `readTranscriptSignals(transcriptPathFor({...}))` → `readTranscriptSignals(transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id }, source.root), source.tail)`
- `readTaskProgress(s.session_id)` → `readTaskProgress(s.session_id, source.root)`
- `readContext(s.session_id)` → `readContext(s.session_id, source.root)`

`readTranscriptSignals` (line ~174) gains the same injected tail as `readRunningSubagents`:

```js
export async function readTranscriptSignals(transcriptPath, tail = tailLines) {
```

with its single `await tailLines(transcriptPath)` becoming `await tail(transcriptPath)`.

- [ ] **Step 6: Run every check that reads sessions**

Run: `node scripts/remote-check.mjs && node scripts/title-check.mjs && node scripts/subagents-check.mjs && node scripts/tasks-check.mjs`
Expected: all four print OK. `title-check` calls `transcriptPathFor` and `readTranscriptSignals` with their old signatures — it passing is the proof the defaults kept every existing caller working.

- [ ] **Step 7: Commit**

```bash
git add src/sessions.mjs scripts/remote-check.mjs
git commit -m "feat: sessions read from a source, not from the local machine"
```

---

### Task 5: Host-qualified folder identity

Two hosts can hold the same path. `/home/pi/x` on two Pis is one key today, which merges two projects into one block with one accent.

**Files:**
- Modify: `src/index.mjs:53-76` (`folderOrder`, `folderAccent`, `accentFor`), `:221-273` (`assignSlots`), `:388` (`isRepeatPress`), `:605`, `:646`, `:738` (`accentFor` call sites)
- Modify: `scripts/slots-check.mjs`

**Interfaces:**
- Consumes: `host` on sessions, from Task 4.
- Produces: `folderKeyFor(session) -> string` exported from `src/index.mjs`. `accentFor` keeps its signature but is called with a folder *key*.

- [ ] **Step 1: Write the failing check**

Append to `scripts/slots-check.mjs`, before its final success log:

```js
// Two hosts can hold the same path. Before folder keys were host-qualified,
// these two sessions shared one block and one accent — a merge nothing on the
// deck would explain.
const twoHosts = [
  { session_id: "a", folder: "/home/pi/x", host: "192.168.2.6", state: "idle", nested: false },
  { session_id: "b", folder: "/home/pi/x", host: "192.168.2.70", state: "idle", nested: false },
];
const twoSlots = new Array(13).fill(null);
assignSlots(twoHosts, twoSlots);
eq(twoSlots[0], "a", "the first host's session takes the first slot");
eq(twoSlots[1], "b", "the second host's session takes its own slot");
eq(
  accentFor(folderKeyFor(twoHosts[0])) !== accentFor(folderKeyFor(twoHosts[1])),
  true,
  "same path on two hosts gets two accents"
);

// And a local session is not merged with a remote one at the same path.
eq(folderKeyFor({ folder: "/x", host: null }), "/x", "a local key is the bare folder, as before");
eq(folderKeyFor({ folder: "/x", host: "h" }), "h:/x", "a remote key is qualified by its host");
```

Add `folderKeyFor` to the import at `scripts/slots-check.mjs:5`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/slots-check.mjs`
Expected: FAIL — `folderKeyFor is not defined`

- [ ] **Step 3: Implement the key**

In `src/index.mjs`, above `claimAccent` (line ~70):

```js
/**
 * A folder's identity across the whole board.
 *
 * Two hosts can hold the same path — `/home/pi/x` on two Raspberry Pis is the
 * live case here — and everything that groups a project keys on the folder:
 * block ordering, accent colour, and the "is this the first key of a block"
 * test. Unqualified, those two projects merge into one block wearing one
 * colour, which nothing on the deck explains.
 *
 * A local session's key is the bare folder, so nothing about a machine with no
 * remote hosts changes, including the accent it has been wearing.
 */
export function folderKeyFor(session) {
  return session.host ? `${session.host}:${session.folder}` : session.folder;
}
```

In `assignSlots`, replace the three `s.folder` uses in the ordering block:

```js
  const liveFolders = new Set(real.map(folderKeyFor));
  for (const s of real) {
    const key = folderKeyFor(s);
    if (!folderOrder.has(key)) folderOrder.set(key, folderOrder.size);
    if (!folderAccent.has(key)) folderAccent.set(key, claimAccent(key, liveFolders));
    if (!sessionOrder.has(s.session_id)) sessionOrder.set(s.session_id, arrivals++);
  }
```

and in the sort:

```js
      folderOrder.get(folderKeyFor(a)) - folderOrder.get(folderKeyFor(b)) ||
```

and in the block test:

```js
    const isPrimary = i === 0 || folderKeyFor(visible[i - 1]) !== folderKeyFor(s);
```

At the three `accentFor(session.folder)` call sites (lines ~605, ~646, ~738), pass the key: `accentFor(folderKeyFor(session))`.

- [ ] **Step 4: Host-qualify the window match in `isRepeatPress`**

A remote window's folder must not match a local session's cwd. In `isRepeatPress`, where a published window's folders are matched against the pressed session, require the host to agree first:

```js
  const windowsOnHost = windows.filter((w) => (w.host ?? null) === (press.session?.host ?? null));
```

and match against `windowsOnHost` in place of `windows`.

- [ ] **Step 5: Run the checks**

Run: `node scripts/slots-check.mjs && node scripts/terminal-focus-check.mjs`
Expected: both print OK. The existing accent assertions at `slots-check.mjs:152-160` pass unchanged — they use bare folder strings, which is exactly what a local key still is.

- [ ] **Step 6: Commit**

```bash
git add src/index.mjs scripts/slots-check.mjs
git commit -m "feat: a folder is identified by its host as well as its path"
```

---

### Task 6: Fetch a host, with a scratch tree that is replaced

The I/O. The tree is renamed into place rather than merged, because a merged tree keeps what the remote deleted — and only one of the four things in it has a pid to check.

**Files:**
- Modify: `src/remote-fs.mjs`
- Modify: `scripts/remote-check.mjs`

**Interfaces:**
- Consumes: `TREE_CMD`, `splitTreeStream`, `sshArgs`, `TAILS_CMD`, `parseTails` (Tasks 2-3); `transcriptPathFor` (Task 4).
- Produces, from `src/remote-fs.mjs`:
  - `swapTree(stagingDir, finalDir) -> Promise<void>`
  - `fetchSource(host, scratchRoot) -> Promise<Source | null>` — a source in the shape Task 4 defined, or `null` on any failure.

- [ ] **Step 1: Write the failing check**

Append to `scripts/remote-check.mjs`, before the final `console.log`:

```js
// --- the tree is replaced, never merged -----------------------------------
import { readdir } from "node:fs/promises";
import { swapTree } from "../src/remote-fs.mjs";

const swapRoot = await mkdtemp(join(tmpdir(), "streamdeck-remote-swap-"));
const finalDir = join(swapRoot, "host");
await mkdir(join(finalDir, "ide"), { recursive: true });
await writeFile(join(finalDir, "ide", "closed.lock"), "{}");

const staging = join(swapRoot, "host.new");
await mkdir(join(staging, "ide"), { recursive: true });
await writeFile(join(staging, "ide", "open.lock"), "{}");

await swapTree(staging, finalDir);
assert.deepEqual(await readdir(join(finalDir, "ide")), ["open.lock"], "a lock the remote deleted does not survive the swap");
assert.deepEqual(await readdir(swapRoot), ["host"], "the staging directory is cleaned up");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL — `swapTree is not a function`

- [ ] **Step 3: Implement the swap and the fetch**

First extend the imports at the top of `src/remote-fs.mjs`:

```js
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tailLines, transcriptPathFor } from "./sessions.mjs";
```

Then append:

```js
/**
 * Replace a host's tree with a freshly extracted one.
 *
 * `tar -xf` merges, and a merged tree keeps what the remote deleted. Only one of
 * the four things in there has a pid to check: a closed window's `ide/*.lock`
 * would linger and keep `matchFolder` matching a folder with no window —
 * silently defeating the invariant the whole join exists to enforce — and
 * `tasks/<id>/` would keep a finished session's list on the detail board.
 *
 * Renaming rather than removing-then-extracting also means a reader sees the old
 * complete tree or the new one, never a half-written one.
 */
export async function swapTree(stagingDir, finalDir) {
  const doomed = `${finalDir}.old`;
  await rm(doomed, { recursive: true, force: true });
  await rename(finalDir, doomed).catch(() => {}); // first fetch: nothing to move
  await rename(stagingDir, finalDir);
  await rm(doomed, { recursive: true, force: true });
}

function run(argv, { input, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve(code === 0 ? Buffer.concat(chunks) : null);
    });
    child.stdin.on("error", () => {}); // a host that closed early is not a crash
    child.stdin.end(input ?? "");
  });
}

/**
 * Everything one host contributes, as a source `getLiveSessions` can read.
 *
 * Two round trips, ~300ms warm. Returns `null` on any failure — a host that is
 * asleep, unreachable, or has never run Claude Code is an ordinary state, and
 * the caller drops its keys the way a closed window's are dropped.
 */
export async function fetchSource(host, scratchRoot) {
  const controlPath = join(scratchRoot, "cm-%h");
  const finalDir = join(scratchRoot, host);
  const staging = `${finalDir}.new`;

  const stream = await run(["ssh", ...sshArgs(host, controlPath), TREE_CMD]);
  if (!stream) return null;
  const { pids, tar } = splitTreeStream(stream);

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // No `-P`: without it both GNU tar and bsdtar strip a leading `/` and refuse
  // `..` members, so a stream cannot write outside the tree. `-P` would disable
  // exactly that — it is the flag to *not* reach for here.
  const extracted = await run(["tar", "-xf", "-", "-C", staging], { input: tar });
  if (extracted === null) {
    await rm(staging, { recursive: true, force: true });
    return null;
  }
  await swapTree(staging, finalDir);

  // The registry is now on local disk, so the daemon resolves transcript paths
  // itself — with the same functions it uses locally — rather than asking the
  // remote to know which files matter.
  const registry = await readJsonFiles(join(finalDir, "sessions"));
  // The remote path is relative to ~/.claude, because TAILS_CMD `cd`s there
  // first: a path read from stdin is data, and `~` is not expanded inside "$f".
  // The local path is the same file inside the fetched tree, and is what the
  // injected `tail` will be asked for — `sessionsFrom` resolves it with this
  // same function against the source's root.
  const wanted = registry
    .filter((s) => s.sessionId && s.cwd && pids.has(s.pid))
    .map((s) => ({
      local: transcriptPathFor({ cwd: s.cwd, sessionId: s.sessionId }, finalDir),
      remote: transcriptPathFor({ cwd: s.cwd, sessionId: s.sessionId }, ""),
    }));

  let tails = new Map();
  if (wanted.length) {
    const body = await run(["ssh", ...sshArgs(host, controlPath), TAILS_CMD], {
      input: wanted.map((w) => w.remote).join("\n") + "\n",
    });
    if (body) {
      const byRemote = parseTails(body, wanted.map((w) => w.remote));
      for (const w of wanted) tails.set(w.local, byRemote.get(w.remote));
    }
  }

  return {
    host,
    root: finalDir,
    isAlive: (pid) => pids.has(pid),
    // A session transcript was never fetched to disk, so it comes from the map.
    // A *subagent* transcript did ride in the tar — small, and needed with its
    // real mtime, since SUBAGENT_IDLE_MAX_S retires an agent by how long it has
    // been quiet — so it is read off the tree like any local file. Without this
    // fallback `readRunningSubagents` asks for a path the map has never heard
    // of, gets the failure value, and no remote session ever shows a subagent.
    tail: async (path) => tails.get(path) ?? tailLines(path),
  };
}
```

This also needs a local `readJsonFiles`. The one in `sessions.mjs` is not exported; copy its six-line body here rather than widening that module's surface for one caller:

```js
async function readJsonFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // partial write or corrupt file — skip it, not a crash
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/remote-check.mjs`
Expected: `remote-check: OK`. No SSH connection is opened — only `swapTree` is exercised.

- [ ] **Step 5: Verify against the real host once, by hand**

Run: `node -e 'import("./src/remote-fs.mjs").then(async m => console.log(JSON.stringify((await m.fetchSource("192.168.2.6", "/tmp/streamdeck-remote")) && "ok")))'`
Expected: `"ok"`. If it prints `null`, the host is unreachable or has no `~/.claude` — check with `ssh -o BatchMode=yes 192.168.2.6 ls .claude` before debugging the code.

- [ ] **Step 6: Commit**

```bash
git add src/remote-fs.mjs scripts/remote-check.mjs
git commit -m "feat: fetch a remote host into a tree that is replaced, not merged"
```

---

### Task 7: Wire it into the daemon

**Files:**
- Modify: `src/index.mjs` (imports, the poll loop's `getLiveSessions()` calls at `:587`, `:627`, `:702`, `:1051`, `:1069`; `focusWindow` at `:170`)
- Modify: `src/window-state.mjs:88-106` (`countVsCodeWindows`)
- Create: `src/remote-hosts.mjs`
- Modify: `scripts/remote-check.mjs`

**Interfaces:**
- Consumes: `fetchSource` (Task 6), `readWindowStates` (Task 1), `localSource` (Task 4).
- Produces, from `src/remote-hosts.mjs`: `dueHosts(windows, now, memo) -> string[]` and `remoteSources(now, memo, fetch) -> Promise<Source[]>`.

- [ ] **Step 1: Write the failing check**

Append to `scripts/remote-check.mjs`, before the final `console.log`:

```js
// --- cadence, backoff and the kill switch ---------------------------------
import { dueHosts } from "../src/remote-hosts.mjs";

const w = (host) => ({ pid: 1, folders: ["/x"], focused: false, activeSessionId: null, host });
const memo = new Map();

assert.deepEqual(dueHosts([w("h1"), w(null)], 0, memo), ["h1"], "only windows with a host are fetched");
assert.deepEqual(dueHosts([w("h1"), w("h1")], 0, memo), ["h1"], "two windows on one host are one fetch");

// A remote host polls slower than the 2s local loop: "not on the critical path"
// is a statement about the daemon, not about the Raspberry Pi it is asking.
memo.set("h1", { lastAt: 0, failures: 0 });
assert.deepEqual(dueHosts([w("h1")], 2000, memo), [], "not due 2s after a success");
assert.deepEqual(dueHosts([w("h1")], 6000, memo), ["h1"], "due 6s after a success");

// Consecutive failures back off 5s, 10s, 30s; one success resets.
memo.set("h2", { lastAt: 0, failures: 1 });
assert.deepEqual(dueHosts([w("h2")], 4000, memo), [], "not due inside the first backoff");
assert.deepEqual(dueHosts([w("h2")], 6000, memo), ["h2"], "due after 5s");
memo.set("h2", { lastAt: 0, failures: 3 });
assert.deepEqual(dueHosts([w("h2")], 20000, memo), [], "a third failure waits 30s");
assert.deepEqual(dueHosts([w("h2")], 31000, memo), ["h2"], "and is due after it");
memo.set("h2", { lastAt: 0, failures: 9 });
assert.deepEqual(dueHosts([w("h2")], 31000, memo), ["h2"], "the backoff is capped at 30s");

process.env.STREAMDECK_NO_REMOTE = "1";
assert.deepEqual(dueHosts([w("h1")], 999999, memo), [], "the kill switch stops every fetch");
delete process.env.STREAMDECK_NO_REMOTE;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/remote-check.mjs`
Expected: FAIL — `Cannot find module '../src/remote-hosts.mjs'`

- [ ] **Step 3: Implement the cadence**

Create `src/remote-hosts.mjs`:

```js
/**
 * Which hosts to fetch on this tick, and the cached sources for the rest.
 *
 * **Remote hosts poll slower than local.** The main loop runs every 2s because
 * a local read is a few file reads; a remote fetch is two SSH round trips plus a
 * held ControlPersist connection against a machine doing its own work — here, a
 * Raspberry Pi running home automation. Nothing on a remote key changes faster
 * than it can be read, so the slower cadence costs nothing visible.
 *
 * Backoff is the shape `usage.mjs` already uses for 429s: each consecutive
 * failure waits longer, one success drops back to the plain interval.
 */
const REMOTE_POLL_MS = 6000;
const BACKOFF_MS = [5000, 10000, 30000];

function waitFor(entry) {
  if (!entry.failures) return REMOTE_POLL_MS;
  return BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length) - 1];
}

export function dueHosts(windows, now, memo) {
  // Every other reader here degrades to nothing by itself; this one holds an
  // open connection to another machine, so it gets a way to be switched off
  // without killing the daemon.
  if (process.env.STREAMDECK_NO_REMOTE === "1") return [];
  const hosts = [...new Set(windows.map((w) => w.host).filter(Boolean))];
  return hosts.filter((h) => {
    const entry = memo.get(h);
    return !entry || now - entry.lastAt >= waitFor(entry);
  });
}

/**
 * Fetch what is due, keep what is not, and drop a host whose window has closed.
 *
 * A failing host's keys vanish the way a closed window's do, and the transition
 * is logged once rather than every poll — a line per 6s for a sleeping Pi is a
 * log nobody reads.
 */
export async function remoteSources(windows, now, memo, fetch) {
  const live = new Set(windows.map((w) => w.host).filter(Boolean));
  for (const host of [...memo.keys()]) if (!live.has(host)) memo.delete(host);

  const due = dueHosts(windows, now, memo);
  await Promise.all(
    due.map(async (host) => {
      const source = await fetch(host);
      const previous = memo.get(host) ?? { failures: 0, source: null };
      if (source) {
        if (previous.failures) console.error(`remote ${host}: reachable again`);
        memo.set(host, { lastAt: now, failures: 0, source });
      } else {
        if (!previous.failures) console.error(`remote ${host}: unreachable, keys dropped`);
        memo.set(host, { lastAt: now, failures: previous.failures + 1, source: null });
      }
    })
  );

  return [...live].map((h) => memo.get(h)?.source).filter(Boolean);
}
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `node scripts/remote-check.mjs`
Expected: `remote-check: OK`

- [ ] **Step 5: Call it from the poll loop**

In `src/index.mjs`, add the imports:

```js
import { fetchSource } from "./remote-fs.mjs";
import { remoteSources } from "./remote-hosts.mjs";
import { getLiveSessions, localSource, matchFolder, readTaskList, taskWindow } from "./sessions.mjs";
```

Add near the other module-level state (around line 53):

```js
// One entry per remote host: its last fetch, its consecutive failures, and the
// source that fetch produced. Held here for the daemon's lifetime, like
// folderOrder — a host that goes away is evicted by remoteSources().
const remoteMemo = new Map();
const SCRATCH_ROOT = join(tmpdir(), `streamdeck-remote-${process.pid}`);

async function allSources() {
  const remotes = await remoteSources(readWindowStates(), Date.now(), remoteMemo, (host) =>
    fetchSource(host, SCRATCH_ROOT)
  );
  return [localSource(), ...remotes];
}
```

Replace every `await getLiveSessions()` in the poll loop (lines ~587, ~627, ~702, ~1051, ~1069) with `await getLiveSessions(await allSources())`.

Add `import { tmpdir } from "node:os";` and `join` to the existing `node:path` import if not already present.

- [ ] **Step 6: Short-circuit `focusWindow` for a remote session**

Pressing a remote key is spec B. Until then, `focusWindow` must not run `anchorFile`/`openFileIn` against a remote path on the local filesystem — that either finds nothing (a log line per press) or, if this machine happens to have the same path, opens an unrelated file.

At the top of `focusWindow` (line ~171):

```js
  const { folder, ide, host } = session;
  // A remote session's folder is another machine's path. Raising its window is
  // spec B — see docs/superpowers/specs/2026-08-16-remote-ssh-sessions-design.md.
  // Until then a remote key reads and does not act, which is quieter than
  // searching this filesystem for a directory that is not on it.
  if (host) return;
```

- [ ] **Step 7: Fix the window-count diagnostic**

`countVsCodeWindows` counts local IDE locks as the denominator for the "N of M windows have the extension" line — the only diagnostic for a window still running the old build. A remote window publishes state (numerator) while its lock sits on the remote (uncounted), so the line reads "6 of 5".

In `src/window-state.mjs`, change `countVsCodeWindows` to accept the published states and count remote windows into the denominator:

```js
export function countVsCodeWindows(dir = IDE_DIR, states = []) {
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
  // A remote window's IDE lock is on the remote host, so it is missing from the
  // count above while its published state is present in the numerator. Counting
  // it here keeps both sides describing the same population.
  return count + new Set(states.filter((s) => s.host).map((s) => s.pid)).size;
}
```

Update its call site in `index.mjs` to pass the states it already reads.

- [ ] **Step 8: Run the whole suite**

Run: `for c in render slots tasks usage stats title subagents colors terminal-focus remote; do echo "== $c"; node scripts/$c-check.mjs || break; done`
Expected: every check prints OK.

- [ ] **Step 9: Run the daemon against the real Pi**

Run: `npm start`
Expected: a key appears for `dom-setup-2d` with `DOM-SETUP` on its caps bar, coloured by state, with its `aiTitle` as the body. Pressing it does nothing (spec B). `STREAMDECK_NO_REMOTE=1 npm start` makes the key disappear.

- [ ] **Step 10: Commit**

```bash
git add src/index.mjs src/remote-hosts.mjs src/window-state.mjs scripts/remote-check.mjs
git commit -m "feat: remote hosts join the board, on their own cadence"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (the architecture diagram, the module list, the invariants)
- Modify: `README.md` (the data sources table)

- [ ] **Step 1: Update the architecture diagram in `CLAUDE.md`**

The diagram at the top currently shows one input. Add the remote branch:

```
~/.claude/{sessions,ide,projects,tasks}   →  sessions.mjs  →  getLiveSessions()
ssh <host> ~/.claude/… → remote-fs.mjs  ↗
```

- [ ] **Step 2: Add `src/remote-fs.mjs` and `src/remote-hosts.mjs` to the module list**

Follow the existing entries' shape — what it does, and the one thing about it that is not obvious. For `remote-fs.mjs` that is: nothing runs on the remote but a POSIX shell, because the daemon already computes every path it needs; and the tree is renamed into place rather than merged, because a merged tree keeps a closed window's lock alive.

- [ ] **Step 3: Amend the `sessions.mjs` entry**

It currently says it is "the only reader of Claude Code's state" and joins against "open VS Code workspace folders". Add that it now reads through a *source* — a root, an `isAlive` and a `tail` — and that a remote host supplies those three and nothing else, so the body is the same code either way.

- [ ] **Step 4: Amend the "Read-only, two install steps" invariant**

It says the daemon "writes exactly one file". It now also writes a scratch tree under `tmpdir()`, named for its own pid. Say so, and say why it is renamed rather than merged.

- [ ] **Step 5: Add an invariant for host-qualified folders**

Under the ordering invariant, record that a folder's identity is `host:folder` for a remote session and the bare path for a local one, and that same-path-two-hosts is the case it exists for.

- [ ] **Step 6: Record the overflow decision**

Under the ordering invariant, one sentence: remote sessions take slots in first-seen order like everything else, with no precedence, because `attentionQueue` is passed the whole session list and a slotless session that wants you still pulses the attention key.

- [ ] **Step 7: Add the remote row to `README.md`'s data sources table**

Source: `ssh <host> ~/.claude/{sessions,ide,tasks,projects}`. What it gives: remote sessions' name, state, title, tasks and subagents. Note that the context gauge is absent on remote hosts, and that a remote window must be reloaded once after upgrading for its host to be published.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: remote SSH sessions, and the three things a source supplies"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Host discovery | 1 |
| §2 Fetching (call 1, call 2, tree replacement, extraction guard) | 2, 3, 6 |
| §3 The three injection points | 4 |
| §4 Collisions (folder identity, window matching) | 5 |
| §5 Overflow: nothing changes | 7 step 6 (`focusWindow` short-circuit), 8 step 6 (recorded) |
| §6 Failure (cadence, backoff, kill switch) | 7 |
| §7 Window count diagnostic | 7 step 7 |
| §8 Checks | 1, 2, 3, 4, 5, 6, 7 — every task ends in one |
| Follow-ons B and C | Out of scope; `focusWindow` short-circuit is the only concession |

**Deferred, deliberately:** the mtime cursor from §2 ("send the previously seen `{path: mtime}` so unchanged tails come back empty") is not implemented. Add it if a WAN link or a busier host complains; a `ponytail:` comment in `fetchSource` should name the ceiling.

**Type consistency:** a *source* is `{ host, root, isAlive, tail }` in Tasks 4, 6 and 7. `tail` returns `{ lines, whole }` in `tailLines`, `parseTails` and `fetchSource`'s fallback alike, including the failure value `{ lines: [], whole: false }`. `folderKeyFor(session)` takes a session, never a folder string; `accentFor` takes a key. `dueHosts(windows, now, memo)` and `remoteSources(windows, now, memo, fetch)` agree on argument order.
