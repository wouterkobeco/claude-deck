// Verifies the reader that finds a file a VS Code window already has open —
// which window's storage answers for a folder, and what shape the answer takes
// for a local window versus a Remote-SSH one.
//
// This file reads an undocumented internal format, so its contract is "never
// throw, return null instead". That is what most of these cases pin: a wrong
// answer here focuses somebody else's window, and a thrown one takes the press
// handler with it.
//
// The fixture shapes are copied from real files on this machine, including the
// percent-encoded `+` in `ssh-remote%2B` and the `external` field VS Code
// writes next to `path`.
// Run: node scripts/vscode-state-check.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFileIn } from "../src/vscode-state.mjs";

const root = await mkdtemp(join(tmpdir(), "streamdeck-vscode-state-check-"));

// One editor entry, in the shape VS Code serialises. A remote entry carries
// `scheme`/`authority`/`external` alongside the plain path; a local one does
// not, and `path` is what the caller wants.
const editor = (resource) => ({ value: JSON.stringify({ resourceJSON: resource }) });

async function window(name, folderUri, resources) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspace.json"), JSON.stringify({ folder: folderUri }));
  const state = {
    "editorpart.state": {
      serializedGrid: { root: { type: "leaf", data: { editors: resources.map(editor), mru: [0] } } },
    },
  };
  // `openFileIn` shells out to sqlite3, so the fixture has to be a real
  // database rather than a JSON file — the query it runs is the contract.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const sql = `create table if not exists ItemTable (key text, value text);
insert into ItemTable values ('memento/workbench.parts.editor', '${JSON.stringify(state).replace(/'/g, "''")}');`;
  await promisify(execFile)("sqlite3", [join(dir, "state.vscdb"), sql]);
  return dir;
}

const LOCAL = "/Users/wouterd/projects/thing";
const REMOTE = "/home/pi/domotica/dom-setup";
const HOST = "192.168.2.6";

await window("local", `file://${LOCAL}`, [{ path: `${LOCAL}/README.md` }]);
await window("remote", `vscode-remote://ssh-remote%2B${HOST}${REMOTE}`, [
  {
    path: `${REMOTE}/README.md`,
    scheme: "vscode-remote",
    authority: `ssh-remote+${HOST}`,
    external: `vscode-remote://ssh-remote%2B${HOST}${REMOTE}/README.md`,
  },
]);

// A local window answers with a plain path, which is what `open -a` takes.
assert.equal(await openFileIn(LOCAL, null, root), `${LOCAL}/README.md`, "a local window yields a path");

// A remote window answers with the URI VS Code itself wrote. Returned verbatim
// rather than rebuilt: the authority arrives percent-encoded and re-encoding it
// by hand is the bug this avoids.
assert.equal(
  await openFileIn(REMOTE, HOST, root),
  `vscode-remote://ssh-remote%2B${HOST}${REMOTE}/README.md`,
  "a remote window yields the encoded URI, not a bare path"
);

// The two must not answer for each other. A local lookup of a remote folder
// finds no window whose `workspace.json` says `file://` — and vice versa —
// because raising the wrong window is exactly the confusion host-qualified
// folder keys exist to prevent one layer up.
assert.equal(await openFileIn(REMOTE, null, root), null, "a remote folder is not found as a local one");
assert.equal(await openFileIn(LOCAL, HOST, root), null, "a local folder is not found as a remote one");

// A window on a different host must never answer, even at the same path. This
// is the check that stops one host's storage raising another host's window.
assert.equal(await openFileIn(REMOTE, "192.168.2.70", root), null, "another host's window does not answer");

// Nothing here may throw. A missing storage directory, a folder no window has,
// and an unreadable tree all have to come back null — this runs on the path to
// a key press.
assert.equal(await openFileIn(LOCAL, null, join(root, "does-not-exist")), null, "a missing storage dir is null");
assert.equal(await openFileIn("/nobody/has/this", null, root), null, "an unknown folder is null");

// The cache is keyed by host as well as folder. Asking for the same path under
// both identities must not let the first answer serve the second — the bug
// would be invisible until two windows shared a path.
assert.equal(await openFileIn(REMOTE, HOST, root), `vscode-remote://ssh-remote%2B${HOST}${REMOTE}/README.md`);
assert.equal(await openFileIn(REMOTE, null, root), null, "a cached remote answer does not serve a local lookup");

console.log("OK: vscode state");
