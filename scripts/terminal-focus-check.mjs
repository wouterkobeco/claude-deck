// Verifies the pid-ancestry walk that matches a Claude session to the VS Code
// terminal running it: Terminal.processId is the shell, and claude is a
// descendant of it, so the chain from claude upwards is what the extension
// matches against.
// Run: node scripts/terminal-focus-check.mjs
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestorChain, parseProcessTable } from "../src/terminal-focus.mjs";
import { requestFocus } from "../src/terminal-focus.mjs";
import { countVsCodeWindows, readWindowStates } from "../src/window-state.mjs";

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

// A local press says so explicitly rather than by omission. The extension has
// to tell "this request is for a local window" from "this request predates
// hosts", and a missing field cannot carry that.
assert.equal((await read()).host, null, "a local request names its host as null");

// A remote session's chain cannot be walked here: its pids live on another
// machine, and `ps` on this one either finds nothing or — worse — finds an
// unrelated local process wearing the same number. The chain is precomputed
// during the poll's own fetch and travels on the session, so a press never
// waits on ssh.
await requestFocus(
  { pid: 2187779, session_id: "sess-remote", host: "192.168.2.6", ancestors: [2187779, 2187575, 2187506] },
  {
    path,
    readProcessTable: async () => {
      throw new Error("a press must never read the local process table for a remote session");
    },
  }
);
assert.deepEqual((await read()).pids, [2187779, 2187575, 2187506], "a remote press uses the chain it was given");
assert.equal((await read()).host, "192.168.2.6", "and names the host it belongs to");

// Host is what stops a local window acting on a remote request. Pids are only
// unique per machine, and a remote pid is an ordinary number here — 2187575 is
// a perfectly plausible local pid. Without the host the two are
// indistinguishable and the wrong terminal is revealed.
await requestFocus(
  { pid: 99684, session_id: "sess-d", host: null },
  { path, readProcessTable: async () => real }
);
assert.equal((await read()).host, null);

// A remote session with no precomputed chain writes nothing rather than
// falling back to the local table, which would match by coincidence or not at
// all — both worse than the press simply not revealing a terminal.
await requestFocus(
  { pid: 2187779, session_id: "sess-remote-nochain", host: "192.168.2.6" },
  { path, readProcessTable: async () => real }
);
assert.equal((await read()).sessionId, "sess-d", "a remote press with no chain leaves the previous request alone");

await rm(dir, { recursive: true, force: true });

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
// A filename that isn't a pid at all: filtered by the `.endsWith(".json")` check.
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

// A live-pid file with syntactically broken JSON, caught mid-write. The
// JSON.parse try-catch must swallow this and return an empty array, not crash.
await winFile(`${process.pid}.json`, "{\"folders\":[");
assert.deepEqual(readWindowStates(wdir), [], "broken JSON is skipped, not a fatal error");

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

// A malformed .lock file with syntactically broken JSON. The JSON.parse
// try-catch must swallow this and not affect the count of valid locks.
await writeFile(join(idedir, "4.lock"), "{\"ideName\":");
assert.equal(countVsCodeWindows(idedir), 2, "corrupt .lock files are skipped, not a fatal error");

await rm(idedir, { recursive: true, force: true });
await rm(wdir, { recursive: true, force: true });

// The extension's version tracks the daemon's, and this is what enforces it.
//
// It isn't bookkeeping: the version is the only way to tell a VS Code window
// running the *current* extension from one still running whatever it loaded at
// startup. `code --list-extensions --show-versions` and Show Running Extensions
// both report it, and the stats board already shows the daemon's — so the two
// numbers agreeing is the whole "do I need to reload this window?" check, done
// by eye and without opening the repo. Let them drift and that comparison
// quietly starts lying, which is worse than not having it.
//
// Read rather than imported with `with { type: "json" }`, same reason index.mjs
// gives: that syntax is parsed before anything runs, so a Node without it would
// fail this check outright rather than degrading.
const versionOf = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).version;
assert.equal(
  versionOf("../extension/package.json"),
  versionOf("../package.json"),
  "extension/package.json version must match the daemon's — bump both together"
);

// `npm start`'s prestart offer, run for real against a fake HOME — every answer
// it can give without a person in front of it. Spawned rather than imported
// because the whole thing *is* its side effects; stdin is a pipe here, which is
// also the "nobody to ask" case.
{
  const run = (home, ...args) =>
    spawnSync(process.execPath, [new URL("./ext-prompt.mjs", import.meta.url).pathname, ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    }).stdout;

  const fake = await mkdtemp(join(tmpdir(), "streamdeck-ext-check-"));
  const copy = join(fake, ".vscode/extensions/claude-streamdeck-terminal-focus");
  const source = new URL("../extension", import.meta.url).pathname;
  const stampedVersion = () => JSON.parse(readFileSync(join(copy, "package.json"), "utf8")).version;
  // A real copy, then whatever this case wants changed about it. The old
  // fixture was a lone package.json holding a version, which stopped being a
  // fixture the moment the decision became "does the code differ".
  const installCopy = () => {
    rmSync(copy, { recursive: true, force: true });
    cpSync(source, copy, { recursive: true });
  };

  // No ~/.vscode. On a machine with the app installed this still finds VS
  // Code — /Applications isn't fakeable — so only assert the branch that
  // machine can reach.
  assert.match(
    run(fake),
    existsSync("/Applications/Visual Studio Code.app") ? /not installed/ : /vscode not detected/,
    "no ~/.vscode: detected via the app bundle, or reported missing"
  );
  await mkdir(join(fake, ".vscode/extensions"), { recursive: true });
  assert.match(run(fake), /not installed/, "vscode present, extension missing: offers to install");

  installCopy();
  assert.equal(run(fake), "", "installed and current: says nothing");

  // The case this was rewritten for. A release bumps both package.json
  // versions, and 172 of 181 commits leave the extension's code alone — so a
  // stamp-only difference must not name a drift and must not ask fifteen
  // windows to reload. It is still copied, because that number on disk is the
  // by-eye "which version is in the slot" check.
  await writeFile(
    join(copy, "package.json"),
    readFileSync(join(source, "package.json"), "utf8").replace(/"version": "[^"]*"/, '"version": "0.0.1"')
  );
  assert.equal(run(fake), "", "a version-only bump is silent");
  assert.equal(stampedVersion(), versionOf("../extension/package.json"), "and re-stamps the slot anyway");

  // Code that really differs — the worktree case, where one extensions slot is
  // shared by every branch. Silent would be wrong here: which version is in
  // there is the fact worth seeing, and a reload really is needed.
  installCopy();
  await writeFile(join(copy, "routing.js"), `${readFileSync(join(copy, "routing.js"), "utf8")}\n// another branch\n`);
  assert.match(run(fake), /installed is v/, "changed code names the drift");
  assert.match(run(fake, "--yes"), /Reload Window/, "and --yes installs it and asks for the reload");
  assert.equal(run(fake), "", "which settles it");

  // A doc-only change must not ask for a reload: nothing loads a .md.
  await writeFile(join(copy, "README.md"), "different\n");
  assert.equal(run(fake), "", "a .md change is not a reload");
  await rm(fake, { recursive: true, force: true });
}

console.log("OK: terminal focus");
