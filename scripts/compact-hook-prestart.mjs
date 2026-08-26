// `npm start`'s third prestart: offer to install the PreCompact/PostCompact
// hooks that let the deck see an *auto*-triggered compaction, not just a
// manual /compact.
//
// Same contract as ext-prompt.mjs and statusline-prompt.mjs: silent when
// there is nothing to do, one line when there is nobody to ask, and every
// path exits 0 — a prestart that can fail the daemon it precedes is a worse
// trade than a missing signal. See src/compact-hook.mjs for the why.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_SCRIPT, SCRIPT_NAME, decide, withHooksInstalled } from "../src/compact-hook.mjs";

const dir = join(homedir(), ".claude");
const scriptPath = join(dir, SCRIPT_NAME);
const settingsPath = join(dir, "settings.json");

// Missing, unreadable and empty all read as "nothing here yet".
const read = (path) => {
  try {
    return readFileSync(path, "utf8") || null;
  } catch {
    return null;
  }
};

const script = read(scriptPath);

let settings;
try {
  settings = JSON.parse(read(settingsPath) ?? "{}");
} catch {
  // A settings.json this can't parse is one to leave alone entirely, the same
  // rule statusline-prompt.mjs follows — writing anything into it would be
  // guessing at a file that already isn't valid JSON.
  console.log(`compaction detection: ${settingsPath} isn't valid JSON — won't touch it. Add the PreCompact/PostCompact hooks from README.md by hand.`);
  process.exit(0);
}

const action = decide({ script, hooks: settings.hooks });
if (action === "ok") process.exit(0);

// `--yes` is what `npm run compact-hook:install` passes.
const forced = process.argv.includes("--yes");

if (!forced && !process.stdin.isTTY) {
  console.log("compaction detection: no PreCompact/PostCompact hooks yet, so an auto-triggered compaction won't show on the deck. run 'npm run compact-hook:install' to add them");
  process.exit(0);
}

const rl = forced ? null : createInterface({ input: process.stdin, output: process.stdout });
// EOF rejects rather than returning "", and an unhandled rejection in a
// prestart takes `npm start` down with it — over an optional signal.
const answer = forced
  ? "y"
  : await rl
      .question("compaction detection: add hooks so an auto-triggered compaction shows on the deck too? [Y/n] ")
      .then((a) => a.trim().toLowerCase())
      .catch(() => "n");
rl?.close();
if (answer === "n" || answer === "no") process.exit(0);

try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${scriptPath}.tmp`, HOOK_SCRIPT);
  chmodSync(`${scriptPath}.tmp`, 0o755);
  renameSync(`${scriptPath}.tmp`, scriptPath);
  writeFileSync(settingsPath, `${JSON.stringify(withHooksInstalled(settings), null, 2)}\n`);
  console.log(`compaction detection: installed ${scriptPath} and wired it into PreCompact/PostCompact.`);
} catch (err) {
  console.log(`compaction detection: couldn't write it (${err.message}). Add the hooks from README.md by hand.`);
}
