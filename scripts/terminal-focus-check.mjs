// Verifies the pid-ancestry walk that matches a Claude session to the VS Code
// terminal running it: Terminal.processId is the shell, and claude is a
// descendant of it, so the chain from claude upwards is what the extension
// matches against.
// Run: node scripts/terminal-focus-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestorChain, parseProcessTable } from "../src/terminal-focus.mjs";
import { requestFocus } from "../src/terminal-focus.mjs";

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

console.log("OK: terminal focus");
