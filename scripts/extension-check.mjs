// Verifies the extension's request routing: whose window a focus request is
// for, and what this window's own identity is.
//
// The extension is the one piece of this project whose bugs otherwise surface
// only by reloading a VS Code window and watching — every mistake this routing
// has made was caught by reading it, not by running it. `extension/routing.js`
// exists to make that testable: it requires nothing and takes `folders` and
// `remoteName` as plain arguments, so the cases below are the real decision
// path, not a re-implementation of it.
//
// CommonJS on purpose — the extension has no build step and no dependencies, so
// it is loaded here the same way VS Code loads it.
// Run: node scripts/extension-check.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sshHost, requestIsOurs } = require("../extension/routing.js");

const folder = (authority) => ({ uri: { authority } });
const SSH = [folder("ssh-remote+192.168.2.6")];

// --- sshHost --------------------------------------------------------------
assert.equal(sshHost(SSH, "ssh-remote"), "192.168.2.6", "a plain ssh-remote authority yields its host");
assert.equal(sshHost([folder("ssh-remote+pi@beast.local")], "ssh-remote"), "pi@beast.local", "user@host passes");

// A local window has no remoteName at all.
assert.equal(sshHost([folder(undefined)], undefined), null, "a local window has no host");
assert.equal(sshHost([], undefined), null, "no folders, no host");

// Every non-SSH remote kind. These are the ones that used to be indistinguishable
// from "local" — a dev-container authority is hex-encoded JSON, and its window's
// terminals are container pids.
assert.equal(sshHost([folder("dev-container+7b22686f7374")], "dev-container"), null, "a dev container is not an ssh host");
assert.equal(sshHost([folder("wsl+Ubuntu")], "wsl"), null, "wsl is not an ssh host");
assert.equal(sshHost([folder("codespaces+abc")], "codespaces"), null, "codespaces is not an ssh host");

// An ssh-remote window can still yield null: nothing open, mixed authorities
// (which cannot happen today, which is exactly why it is asserted), or a host
// this build declines to name.
assert.equal(sshHost([], "ssh-remote"), null, "an ssh-remote window with no folder open yields nothing");
assert.equal(
  sshHost([folder("ssh-remote+a.example"), folder("ssh-remote+b.example")], "ssh-remote"),
  null,
  "two authorities in one window is refused rather than guessed"
);
assert.equal(sshHost([folder("ssh-remote+has space")], "ssh-remote"), null, "a host the regex refuses is not named");
assert.equal(sshHost([folder("ssh-remote+-oProxyCommand=x")], "ssh-remote"), null, "a leading dash is refused");
assert.equal(sshHost([folder("ssh-remote+")], "ssh-remote"), null, "an empty host is refused");

// Two folders on the same host is the ordinary multi-root remote case.
assert.equal(
  sshHost([folder("ssh-remote+192.168.2.6"), folder("ssh-remote+192.168.2.6")], "ssh-remote"),
  "192.168.2.6",
  "multi-root on one host still names it"
);

// --- requestIsOurs --------------------------------------------------------
const now = 1_000_000;
const fresh = (extra) => ({ pids: [42], ts: now, ...extra });

const LOCAL = { remoteName: undefined, folders: [], now };
const REMOTE = { remoteName: "ssh-remote", folders: SSH, now };
const CONTAINER = { remoteName: "dev-container", folders: [folder("dev-container+7b22")], now };

// The ordinary two cases.
assert.equal(requestIsOurs(fresh({ host: null }), LOCAL), true, "a local window takes a local request");
assert.equal(requestIsOurs(fresh({ host: "192.168.2.6" }), REMOTE), true, "a remote window takes its own host's request");

// Neither may take the other's. A pid is unique per machine and nothing else in
// the request is, so without the host these two are indistinguishable.
assert.equal(requestIsOurs(fresh({ host: "192.168.2.6" }), LOCAL), false, "a local window refuses a remote request");
assert.equal(requestIsOurs(fresh({ host: null }), REMOTE), false, "a remote window refuses a local request");
assert.equal(
  requestIsOurs(fresh({ host: "192.168.2.70" }), REMOTE),
  false,
  "and refuses another host's request even though both are remote"
);

// The finding this check exists for. A dev-container window's `sshHost` is null,
// same as a local window's — but its terminals are container pids, so taking a
// local request means matching against a pid space belonging to no machine the
// daemon asked about, and revealing a terminal in a window nobody pressed.
assert.equal(
  requestIsOurs(fresh({ host: null }), CONTAINER),
  false,
  "a dev-container window refuses a local request, though its host is null too"
);
assert.equal(requestIsOurs(fresh({ host: "192.168.2.6" }), CONTAINER), false, "and refuses a remote one");
// Same rule for an ssh-remote window whose host this build cannot name: it is
// still not local, so it claims nothing rather than claiming to be local.
assert.equal(
  requestIsOurs(fresh({ host: null }), { remoteName: "ssh-remote", folders: [folder("ssh-remote+has space")], now }),
  false,
  "an ssh window with an unnameable host claims nothing"
);

// A request from a daemon that predates the host field is read as local, which
// is what it was — that daemon could only describe local sessions.
assert.equal(requestIsOurs(fresh({}), LOCAL), true, "a request with no host field still works in a local window");
assert.equal(requestIsOurs(fresh({}), REMOTE), false, "and is correctly refused by a remote one");

// Freshness and shape. A stale request must not be acted on when a closed window
// reopens, and a malformed one must not throw on the way to being refused.
assert.equal(requestIsOurs(fresh({ host: null }), { ...LOCAL, now: now + 5001 }), false, "a stale request is refused");
assert.equal(requestIsOurs(fresh({ host: null }), { ...LOCAL, now: now + 4999 }), true, "one just inside the window is not");
assert.equal(requestIsOurs({ pids: "nope", ts: now, host: null }, LOCAL), false, "pids must be an array");
assert.equal(requestIsOurs({ ts: now, host: null }, LOCAL), false, "a request with no pids is refused");
assert.equal(requestIsOurs(null, LOCAL), false, "no request at all is refused rather than thrown on");
assert.equal(requestIsOurs({ pids: [1] }, LOCAL), false, "a request with no ts is refused");

// --- restore: which published sessions are this window's ------------------
// The other half of the same problem — routing.js decides whose *request* this
// is, restore.js decides whose *sessions* these are. Both get it wrong in the
// same invisible way: by acting on another window's data.
const { sessionsForWindow, toRestore, resumeCommand } = require("../extension/restore.js");

const ID = "ac185680-913f-4c24-ace4-2ee9edea6405";
const ID2 = "62f1c5d8-b1d2-40be-a260-1a817f7f0983";
const row = (over = {}) => ({ id: ID, cwd: "/Users/w/p", folder: "/Users/w/p", host: null, title: "T", ...over });

assert.deepEqual(
  sessionsForWindow([row()], ["/Users/w/p"], null),
  [{ id: ID, cwd: "/Users/w/p", title: "T" }],
  "a local window keeps its own folder's session"
);
assert.deepEqual(sessionsForWindow([row()], ["/Users/w/other"], null), [], "and drops another folder's");

// The reason a local window compares `host` instead of assuming it: one path
// can exist on this machine and on a remote host at once, and matching on the
// folder alone would hand each window the other's sessions.
const remoteRow = row({ cwd: "/home/pi/p", folder: "/home/pi/p", host: "192.168.2.6" });
assert.deepEqual(sessionsForWindow([remoteRow], ["/home/pi/p"], null), [], "a local window refuses a remote row");
assert.deepEqual(sessionsForWindow([row({ folder: "/home/pi/p", cwd: "/home/pi/p" })], ["/home/pi/p"], "192.168.2.6"), [],
  "and a remote window refuses a local one");
assert.equal(sessionsForWindow([remoteRow], ["/home/pi/p"], "192.168.2.6").length, 1, "a remote window keeps its own host's");
assert.deepEqual(sessionsForWindow([remoteRow], ["/home/pi/p"], "192.168.2.70"), [], "but not another host's, same path");

// A session id reaches a shell (`claude --resume <id>`), and for a remote
// window it was chosen by the other machine. Refused here, and refused again at
// the point of use, so no future caller can route around this filter.
assert.deepEqual(sessionsForWindow([row({ id: "; rm -rf ~" })], ["/Users/w/p"], null), [], "a non-uuid id is dropped");
assert.deepEqual(sessionsForWindow([row({ id: `${ID} && curl evil` })], ["/Users/w/p"], null), [], "and so is one with a real id inside it");
assert.throws(() => resumeCommand("$(whoami)"), "resumeCommand refuses what sessionsForWindow would never hand it");
assert.equal(resumeCommand(ID), `claude --resume ${ID}`, "and builds the plain command for a real id");

// Junk from a truncated or foreign file is refused rather than thrown on — this
// runs on a timer in every open window.
assert.deepEqual(sessionsForWindow(null, ["/Users/w/p"], null), [], "a non-array file is refused");
assert.deepEqual(sessionsForWindow([null, 7, {}], ["/Users/w/p"], null), [], "and so are rows that aren't rows");
assert.equal(sessionsForWindow([row({ title: 42 })], ["/Users/w/p"], null)[0].title, null, "a non-string title becomes no title");
assert.equal(sessionsForWindow([row({ title: undefined })], ["/Users/w/p"], null)[0].title, null, "and a missing one too");

// Restoring is what's remembered minus what's running: an ordinary reload keeps
// its terminals, so every row is live and the picker is correctly empty.
const savedTwo = [{ id: ID, cwd: "/a" }, { id: ID2, cwd: "/b" }];
assert.deepEqual(toRestore(savedTwo, savedTwo), [], "a reload that kept its terminals offers nothing");
assert.deepEqual(toRestore(savedTwo, []), savedTwo, "a restart that lost them offers both");
assert.deepEqual(toRestore(savedTwo, [{ id: ID }]), [savedTwo[1]], "and a second run offers only what the first didn't restore");

// The two sides meet here: what the daemon publishes has to be what the window
// can read. A field renamed on one side and not the other is invisible until a
// restore silently offers nothing.
const { sessionRows } = await import("../src/publish-sessions.mjs");
const published = sessionRows([
  { session_id: ID, cwd: "/Users/w/p/worktree", folder: "/Users/w/p", host: null, aiTitle: "Fix the thing", nested: false },
  { session_id: ID2, cwd: "/Users/w/p", folder: "/Users/w/p", host: null, name: "p-0d", nested: true },
]);
assert.deepEqual(
  sessionsForWindow(published, ["/Users/w/p"], null),
  [{ id: ID, cwd: "/Users/w/p/worktree", title: "Fix the thing" }],
  "a worktree session lands on its window's folder, and a nested one is never published at all"
);

// The two transfer commands. Same reason routing.js and restore.js are split
// out: this is a string that gets typed into a shell, from a name read off a
// directory anyone can drop a file into.
{
  const { bundleList, isBundleName, restorePlanCommand, saveCommand, shellQuote } = require("../extension/transfer.js");

  // Newest first, because the name format is chronological by construction.
  assert.deepEqual(
    bundleList(["2026-08-21-0930.tgz", "2026-08-23-1104.tgz", "2026-08-22-1200.tgz"]),
    ["2026-08-23-1104.tgz", "2026-08-22-1200.tgz", "2026-08-21-0930.tgz"],
    "bundles are offered newest first"
  );
  // Anything that isn't one of ours is not offered — the directory is an
  // ordinary one and the name reaches a shell.
  assert.deepEqual(
    bundleList(["notes.txt", "2026-08-23-1104.tgz", "; rm -rf ~.tgz", "..", "2026-08-23-1104.tgz.bak"]),
    ["2026-08-23-1104.tgz"],
    "only date-stamped .tgz names this tool writes are offered"
  );
  assert.deepEqual(bundleList(undefined), [], "no directory at all is no bundles, not a throw");
  assert.equal(isBundleName("2026-08-23-1104.tgz"), true);
  assert.equal(isBundleName("../../etc/passwd"), false);

  // A project called `it's mine` is an ordinary thing to have, and would
  // otherwise close the quote and hand the rest of the line to the shell.
  assert.equal(shellQuote("/Users/w/p/plain"), "'/Users/w/p/plain'");
  assert.equal(shellQuote("/Users/w/it's mine"), `'/Users/w/it'\\''s mine'`);
  assert.equal(saveCommand("/Users/w/p/kob trace"), "npm run sessions:save -- '/Users/w/p/kob trace'");
  assert.throws(() => saveCommand(""), /no folder/);

  // The per-window command cannot reach a remote host's sessions — its filter
  // is a substring match on the window's own folder, and a local path never
  // matches `/home/wouterd/...`. Measured against the live daemon: 7 remote
  // sessions, 0 of them matching this checkout's folder. Hence a second
  // command that filters nothing.
  const { saveAllCommand } = require("../extension/transfer.js");
  assert.equal(saveAllCommand(), "npm run sessions:save", "saving everything passes no filter at all");
  assert.equal(
    saveAllCommand().includes("--"),
    false,
    "no `--`, or npm hands the script an empty argument and it filters on the empty string"
  );
  assert.notEqual(saveAllCommand(), saveCommand("/Users/w/p"), "and it is genuinely a different command");

  // The extension never writes: it shows the plan and stops there.
  assert.equal(restorePlanCommand("2026-08-23-1104.tgz"), "npm run sessions:restore -- '2026-08-23-1104.tgz'");
  assert.equal(
    restorePlanCommand("2026-08-23-1104.tgz").includes("--write"),
    false,
    "the palette entry shows the plan and never lands it — that consent is typed, not clicked"
  );
  assert.throws(() => restorePlanCommand("x.tgz; rm -rf /"), /not a bundle/);

  // A remote window's terminal runs on the *other* machine, while this
  // extension's host runs here (`extensionKind: ["ui"]`) — so handing
  // createTerminal a local checkout path there dies with `Starting directory
  // (cwd) "…" does not exist`. Reported live from a Remote-SSH window before
  // this guard existed.
  const { transferAvailability } = require("../extension/transfer.js");
  assert.equal(transferAvailability(undefined).ok, true, "a local window can run them");
  assert.equal(transferAvailability("").ok, true, "and so does an empty remoteName, which is what local really looks like");
  for (const remote of ["ssh-remote", "dev-container", "wsl", "codespaces", "attached-container"]) {
    const v = transferAvailability(remote);
    assert.equal(v.ok, false, `${remote} puts the terminal somewhere else`);
    assert.match(v.reason, /remote/, "and says so rather than failing at the terminal");
  }
  // Deliberately broader than sshHost's own test: that one answers "which
  // host", this one answers "will the terminal land here", and every remote
  // kind fails the second whether or not sshHost recognises it.
  assert.equal(transferAvailability("dev-container").ok, false, "not just ssh-remote");
}

console.log("OK: extension routing, session restore, session transfer");
