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

console.log("OK: extension routing");
