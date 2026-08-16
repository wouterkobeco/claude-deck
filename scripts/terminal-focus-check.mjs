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
