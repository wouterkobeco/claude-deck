/**
 * The daemon half of cmux focus: reveal the cmux pane a session is running in.
 *
 * The join is the session's own environment. cmux starts every pane's shell
 * with its identifiers in the environment, so the running `claude` process
 * carries them and `ps -E` hands them back:
 *
 *   CMUX_PANEL_ID=DEEFF0F2-…      the pane, which `focus-panel` takes
 *   CMUX_SOCKET_CAPABILITY=v1.…   without it the app socket answers
 *                                 "only processes started inside cmux can connect"
 *   CMUX_BUNDLED_CLI_PATH=…       the CLI that speaks to the running app
 *   CMUX_BUNDLE_ID=com.cmuxterm.app
 *
 * `sessions.mjs` decides *whether* a session is in cmux from the registry's
 * own `tmux` field, which is free — it is already read every poll. This
 * module answers the different question of *which pane*, and does it at press
 * time rather than on the poll, for the same two reasons `terminal-focus.mjs`
 * reads its process table at press time: a `ps` per session per 2s buys
 * nothing, and a capability token is not a thing to keep in polled state.
 *
 * Everything here degrades to a logged line. cmux not installed, the app
 * restarted since the pane's shell started, an environment without the
 * variables — all of them mean "no pane to focus", which is an ordinary state
 * for a machine that mostly runs sessions in VS Code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// None of these four values can contain a space — three are identifiers and
// one is a path cmux controls — which is what makes splitting on whitespace a
// correct parse rather than a hopeful one.
const WANTED = ["CMUX_PANEL_ID", "CMUX_SOCKET_CAPABILITY", "CMUX_BUNDLED_CLI_PATH", "CMUX_BUNDLE_ID"];

/**
 * The cmux identifiers in one `ps -E` line, or null if it isn't a cmux pane.
 *
 * **The last assignment wins, not the first.** `ps -E` prints the command
 * line *then* the environment, and a command line here is not inert text: the
 * session this was written in runs with an `--append-system-prompt` argument
 * thousands of characters long. An argument mentioning `CMUX_PANEL_ID=…` would
 * otherwise be read as the pane to focus.
 *
 * Pure, and exported, because a wrong answer here is invisible from outside:
 * a mis-parsed panel id fails exactly the way an uninstalled cmux does.
 */
export function parseCmuxEnv(psOutput) {
  const found = {};
  for (const token of String(psOutput).split(/\s+/)) {
    const at = token.indexOf("=");
    if (at <= 0) continue;
    const name = token.slice(0, at);
    if (WANTED.includes(name)) found[name] = token.slice(at + 1);
  }
  // A pane with no capability cannot be focused and a CLI that isn't there
  // cannot be run, so a partial answer is no answer — reporting one would
  // turn a press into a subprocess that always fails.
  if (WANTED.some((name) => !found[name])) return null;
  return {
    panelId: found.CMUX_PANEL_ID,
    capability: found.CMUX_SOCKET_CAPABILITY,
    cli: found.CMUX_BUNDLED_CLI_PATH,
    bundleId: found.CMUX_BUNDLE_ID,
  };
}

// `-ww` because the default output is truncated to the terminal width, and the
// environment is at the end of the line — the part that would be cut.
async function readCmuxEnv(pid) {
  const { stdout } = await execFileAsync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]);
  return stdout;
}

/**
 * Reveal `session`'s cmux pane and bring cmux to the front.
 *
 * Two steps, in this order: the pane is selected inside the app first, so the
 * window that comes forward is already showing the right session rather than
 * switching under the cursor.
 *
 * Not awaited by its caller, and it never rejects — a press must not wait on a
 * `ps` call, and a failed focus is a logged line, not a dark deck.
 */
export async function focusCmuxPane(session, { readEnv = readCmuxEnv } = {}) {
  let env;
  try {
    env = parseCmuxEnv(await readEnv(session.pid));
  } catch (err) {
    console.error(`cmux focus failed for ${session.folder}:`, err.message);
    return;
  }
  if (!env) {
    console.error(`cmux focus failed for ${session.folder}: pid ${session.pid} carries no cmux environment`);
    return;
  }
  try {
    await execFileAsync(env.cli, ["focus-panel", "--panel", env.panelId], {
      // CMUX_QUIET silences the CLI's own deprecation notices, which are
      // written to stdout and would otherwise read as failures in the log.
      env: { ...process.env, CMUX_SOCKET_CAPABILITY: env.capability, CMUX_QUIET: "1" },
    });
    // `open -b` by bundle id rather than `-a cmux` by name: the id is the one
    // the pane itself reported, so this raises the app the session is actually
    // in even if another build is installed under a different name.
    await execFileAsync("open", ["-b", env.bundleId]);
  } catch (err) {
    console.error(`cmux focus failed for ${session.folder}:`, err.stderr || err.message);
  }
}
