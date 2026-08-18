// `npm start`'s other prestart: offer to install the context-gauge block into
// this machine's status line.
//
// The gauge was the one part of setup that could only be done by copying a
// block out of the README, and a machine that skipped it shows no gauge and no
// reason why — the daemon treats a missing ctx file as "no context to report",
// which is also what a healthy machine mid-first-turn looks like. `npm start`
// is the one moment someone is definitely watching, which is where ext-prompt
// already asks its question.
//
// Same contract as ext-prompt.mjs: silent when there is nothing to do, one line
// when there is nobody to ask, and every path exits 0. A prestart that can fail
// the daemon it precedes is a worse trade than a missing gauge.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CTX_BLOCK, MINIMAL, SCRIPT_NAME, decide, insertBlock } from "../src/statusline.mjs";

const dir = join(homedir(), ".claude");
const scriptPath = join(dir, SCRIPT_NAME);
const settingsPath = join(dir, "settings.json");

// Missing, unreadable and empty all read as "no status line": the fix is the
// same write either way, and an empty file is not something anyone wrote.
const read = (path) => {
  try {
    return readFileSync(path, "utf8") || null;
  } catch {
    return null;
  }
};

const script = read(scriptPath);
const settings = (() => {
  try {
    return JSON.parse(read(settingsPath) ?? "{}");
  } catch {
    // A settings.json this can't parse is one to leave alone, and saying "no
    // statusLine key" would invite exactly the write that must not happen.
    // Reported as a command it doesn't recognise, which is `manual`.
    return { statusLine: { command: "unparseable settings.json" } };
  }
})();

const action = decide({
  jq: spawnSync("jq", ["--version"]).status === 0,
  script,
  statusLine: typeof settings.statusLine?.command === "string" ? settings.statusLine.command : null,
});

if (action === "ok") process.exit(0);

if (action === "nojq") {
  console.log("context gauge: the status line block parses Claude Code's JSON with jq, and there is none. `brew install jq`.");
  process.exit(0);
}

if (action === "manual") {
  console.log(`context gauge: ${settings.statusLine?.command ?? scriptPath} is a status line I won't edit. To turn the gauge on, add:\n`);
  console.log(CTX_BLOCK);
  console.log("\n...after the line that reads stdin into $input.");
  process.exit(0);
}

const notice =
  action === "install"
    ? "context gauge: no status line on this machine."
    : `context gauge: ${scriptPath} has no ctx block.`;
const verb = action === "install" ? "install one" : "add it";

// `--yes` is what `npm run statusline:install` passes: the same decision and
// the same writes, without the question. It is how the non-TTY line below is
// actually acted on.
const forced = process.argv.includes("--yes");

// Nobody to ask (piped, CI, a launchd job): say what was skipped and start.
if (!forced && !process.stdin.isTTY) {
  console.log(`${notice} run 'npm run statusline:install' to ${verb}`);
  process.exit(0);
}

const rl = forced ? null : createInterface({ input: process.stdin, output: process.stdout });
// EOF rejects rather than returning "", and an unhandled rejection in a
// prestart takes `npm start` down with it — over an optional gauge.
const answer = forced
  ? "y"
  : await rl
      .question(`${notice} ${verb} now? [Y/n] `)
      .then((a) => a.trim().toLowerCase())
      .catch(() => "n");
rl?.close();
// Yes is the default in both directions: Enter takes it, and so does anything
// that isn't an explicit no ("sure", a fat-fingered "yy"). Only "n"/"no" — and
// EOF, which the catch above turns into one — declines.
if (answer === "n" || answer === "no") process.exit(0);

try {
  // Written via a temp file and moved into place, the same way the block itself
  // writes ctx files: a status line read while half-written breaks every turn
  // until the next write. The .bak is for the append case — this is the user's
  // own file, and the edit is the only destructive thing this project does to
  // one it didn't create.
  mkdirSync(dir, { recursive: true });
  const body = action === "install" ? MINIMAL : insertBlock(script);
  if (script) copyFileSync(scriptPath, `${scriptPath}.bak`);
  writeFileSync(`${scriptPath}.tmp`, body);
  chmodSync(`${scriptPath}.tmp`, 0o755);
  renameSync(`${scriptPath}.tmp`, scriptPath);

  // Only for a machine that had nothing: an existing status line is already
  // wired up, and rewriting settings.json to say what it already says is a
  // chance to reformat a file holding plugins, theme and everything else.
  if (action === "install") {
    settings.statusLine = { type: "command", command: `~/.claude/${SCRIPT_NAME}` };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  console.log(`context gauge: ${action === "install" ? "installed" : "added to"} ${scriptPath}. It appears once each session takes a turn.`);
} catch (err) {
  console.log(`context gauge: couldn't write it (${err.message}). Add the block from README.md by hand.`);
}
