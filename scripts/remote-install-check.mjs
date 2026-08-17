// Verifies what `remote:install` decides about a host before it writes
// anything to it. That decision is shell semantics, so the probe is run here
// under a real shell against fixture directories rather than asserted as a
// string — a check on the string would have passed just as happily while `-e`
// was refusing to install over an empty file.
//
// No ssh: the probe takes its directory from `$CLAUDE_DIR`, which is what makes
// it runnable against a fixture at all.
// Run: node scripts/remote-install-check.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { STATE_PROBE, parseState } from "./remote-install.mjs";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "streamdeck-install-check-"));

async function probe(name, { script, settings }) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (script !== undefined) await writeFile(join(dir, "statusline-command.sh"), script);
  if (settings !== undefined) await writeFile(join(dir, "settings.json"), settings);
  const { stdout } = await execFileAsync("sh", ["-c", STATE_PROBE], {
    env: { ...process.env, CLAUDE_DIR: dir },
  });
  return parseState(stdout);
}

// Nothing there at all: the ordinary case for a host that has never had a
// status line, and the one the install is for.
assert.equal((await probe("bare", {})).script, "NO", "no status line reads as absent");
assert.equal((await probe("bare2", {})).key, "UNKNOWN", "no settings.json at all is unknown, not YES");

// The finding this check exists for. A zero-byte statusline-command.sh is not a
// status line anyone wrote — a placeholder, a truncated write, a `touch` — and
// treating it as one made the install refuse itself out of a file with nothing
// in it, on a real host, with no `statusLine` key even referencing it.
assert.equal((await probe("empty", { script: "" })).script, "NO", "an empty status line reads as absent");

// A file with content is still refused. That is the guard's actual job: a status
// line is read on every turn, and replacing one to feed a gauge on a key is not
// a trade this makes on someone's behalf.
assert.equal((await probe("real", { script: "#!/bin/sh\necho hi\n" })).script, "YES", "a real status line is respected");
// Even one byte of it.
assert.equal((await probe("tiny", { script: "\n" })).script, "YES", "a newline is content, and is respected");

// The settings.json half, which is refused independently: a host can have no
// script but already point `statusLine` at something else entirely.
assert.equal((await probe("nokey", { settings: '{"theme":"dark"}' })).key, "NO", "settings without statusLine is NO");
assert.equal(
  (await probe("haskey", { settings: '{"statusLine":{"type":"command","command":"x"}}' })).key,
  "YES",
  "an existing statusLine is seen and will be refused"
);
// Unparseable settings must not read as "no statusLine" — that would install
// over a host whose config we could not read, which is exactly when to stop.
assert.equal((await probe("broken", { settings: "{not json" })).key, "UNKNOWN", "unreadable settings is unknown, not NO");

// parseState must not lose a value containing '=', which a path can.
assert.deepEqual(parseState("jq=/usr/bin/jq\nscript=NO\nkey=a=b\n"), {
  jq: "/usr/bin/jq",
  script: "NO",
  key: "a=b",
}, "values split on the first = only");

console.log("OK: remote install probe");
