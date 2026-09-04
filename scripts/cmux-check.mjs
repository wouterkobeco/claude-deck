// Verifies the two halves of cmux support: which sessions earn a key without
// an IDE lock, and which pane a press resolves to.
//
// The parse is the piece worth guarding. `ps -E` prints the command line
// before the environment, and this project's own sessions run with a
// multi-thousand-character `--append-system-prompt` argument — text that can
// say anything, including something that looks exactly like the assignment
// being searched for.
// Run: node scripts/cmux-check.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusCmuxPane, parseCmuxEnv } from "../src/cmux-focus.mjs";
import { getLiveSessions, localSource, transcriptPathFor } from "../src/sessions.mjs";

// --- the parse ---------------------------------------------------------

const PANEL = "DEEFF0F2-EECA-4438-964C-8472A8D30E2E";
const CAP = "v1.-8uWtVMKABOgX4gtHvvUlPxkijxnolzxpmFbkDVUByc.Tbh9xEOIH5YQb4C_SLNZ";
const CLI = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const envTail = [
  `CMUX_BUNDLED_CLI_PATH=${CLI}`,
  `CMUX_PANEL_ID=${PANEL}`,
  `CMUX_SOCKET_CAPABILITY=${CAP}`,
  "CMUX_BUNDLE_ID=com.cmuxterm.app",
  "CMUX_SHELL_INTEGRATION=1",
].join(" ");

assert.deepEqual(
  parseCmuxEnv(`/Users/x/.local/bin/claude ${envTail}\n`),
  { panelId: PANEL, capability: CAP, cli: CLI, bundleId: "com.cmuxterm.app" },
  "a cmux pane's ps -E line yields its four identifiers"
);

// The real shape of the failure this guards: an argument that mentions the
// variable. The environment is printed last, so the last assignment is the
// real one — a first-match parse would focus the pane the prompt named.
assert.equal(
  parseCmuxEnv(`/Users/x/.local/bin/claude --append-system-prompt set CMUX_PANEL_ID=ATTACKER ${envTail}`).panelId,
  PANEL,
  "an argument mentioning CMUX_PANEL_ID does not outrank the environment"
);

assert.equal(parseCmuxEnv("/bin/zsh TERM=xterm-256color SHELL=/bin/zsh"), null, "a plain shell is not a cmux pane");
assert.equal(
  parseCmuxEnv(`/Users/x/.local/bin/claude CMUX_PANEL_ID=${PANEL} CMUX_BUNDLE_ID=com.cmuxterm.app`),
  null,
  "a pane with no capability and no CLI is no answer at all — a partial one would only fail later"
);

// A press on a pid carrying no cmux environment must not throw out of the
// synchronous press handler, and must not run anything.
let ran = false;
await focusCmuxPane(
  { pid: 1, folder: "/tmp/x", session_id: "s" },
  {
    readEnv: async () => {
      ran = true;
      return "/sbin/launchd";
    },
  }
);
assert.ok(ran, "the environment is read before giving up");

// A `ps` that fails outright (the process exited between the poll and the
// press) is the same ordinary state, not a rejection.
await focusCmuxPane({ pid: 1, folder: "/tmp/x", session_id: "s" }, {
  readEnv: async () => {
    throw new Error("No such process");
  },
});

// --- the join ----------------------------------------------------------

const fx = await mkdtemp(join(tmpdir(), "streamdeck-cmux-check-"));
await mkdir(join(fx, "sessions"), { recursive: true });
await mkdir(join(fx, "ide"), { recursive: true });

const CWD = "/Users/x/projects/kob-trace";
const SID = "eac0680a-36d3-4a16-ac20-cc598a1eabdf";
const PANE = "cmux:@5395883817127676569.%5906170420978787672";

const entry = (extra) =>
  JSON.stringify({
    pid: process.pid,
    sessionId: SID,
    cwd: CWD,
    kind: "interactive",
    entrypoint: "cli",
    name: "kob-trace-33",
    status: "idle",
    statusUpdatedAt: 1788512326506,
    ...extra,
  });

const only = async () => {
  const out = await getLiveSessions([localSource(fx)]);
  return out[0] ?? null;
};

// The whole point: no IDE lock anywhere, and the session still gets a key.
await writeFile(join(fx, "sessions", "16863.json"), entry({ tmux: PANE }));
const transcript = transcriptPathFor({ cwd: CWD, sessionId: SID }, fx);
await mkdir(join(transcript, ".."), { recursive: true });
await writeFile(transcript, JSON.stringify({ type: "assistant", aiTitle: "cmux teams" }) + "\n");

const inCmux = await only();
assert.ok(inCmux, "a cmux session needs no VS Code window to earn a key");
assert.equal(inCmux.cmux, PANE, "the pane it is running in rides along to the press handler");
assert.equal(inCmux.folder, CWD, "the pane is the window, so its own cwd is the folder");
assert.equal(inCmux.ide, null, "no editor claims it");

// Same session with a VS Code window open on the same folder. The lock must
// not win: `focusWindow` routes on `ide`, so borrowing the editor's folder
// would send every press to VS Code instead of to the pane.
await writeFile(
  join(fx, "ide", "31165.lock"),
  JSON.stringify({ workspaceFolders: [CWD], ideName: "Visual Studio Code" })
);
const alsoOpenInVsCode = await only();
assert.equal(alsoOpenInVsCode.cmux, PANE, "an editor open on the same folder does not un-cmux the session");
assert.equal(alsoOpenInVsCode.ide, null, "and does not claim the press");

// Narrow on purpose. A plain tmux pane is focused by a mechanism this daemon
// does not have, so it keeps the ordinary lock rule rather than getting a key
// whose press does nothing.
await writeFile(join(fx, "sessions", "16863.json"), entry({ tmux: "main:@1.%2" }));
assert.equal((await only()).cmux, null, "a plain tmux session is not treated as cmux");

// A remote cmux session too: the app socket and the capability are on this
// machine, so its key would raise a pane on the wrong computer. Put the real
// cmux pane back first — read against the plain-tmux fixture left above, this
// assertion passes for the wrong reason and tests nothing.
await writeFile(join(fx, "sessions", "16863.json"), entry({ tmux: PANE }));
assert.equal((await only()).cmux, PANE, "the cmux fixture is back before the remote source reads it");
const remote = await getLiveSessions([
  {
    host: "192.168.2.70",
    root: fx,
    isAlive: () => true,
    tail: async () => ({ lines: [], whole: true }),
  },
]);
assert.equal(remote.length, 1, "the fixture still yields its session over a remote source");
assert.equal(remote[0].cmux, null, "a remote session is never routed to this machine's cmux");

console.log("cmux-check: ok");
