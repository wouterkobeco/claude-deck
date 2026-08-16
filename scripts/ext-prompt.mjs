// `npm start`'s prestart: offer to install the VS Code extension when it isn't
// there, and warn when the installed copy has drifted from this checkout's.
//
// The extension normally rides in on `npm install`'s postinstall, so this only
// fires for the cases that miss it — a checkout whose install predates the
// extension, a copy deleted since, or a `~/.vscode/extensions` slot another
// worktree overwrote (that one is a *drift*, not an absence: most work here
// happens in worktrees and there is only one extensions slot). Neither shows
// up anywhere by design — a window without the extension simply doesn't reveal
// terminals — and `npm start` is the one moment a person is definitely
// watching.
//
// Never fatal: every path here exits 0. A prestart that can fail the daemon it
// precedes is a worse trade than a missing extension.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const installedDir = join(home, ".vscode/extensions/claude-streamdeck-terminal-focus");

// null covers both "not installed" and "installed but unreadable" — the fix is
// the same copy either way, so they don't need telling apart.
const versionOf = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version ?? null;
  } catch {
    return null;
  }
};
const installed = versionOf(join(installedDir, "package.json"));
const mine = versionOf(new URL("../extension/package.json", import.meta.url).pathname);

if (installed === mine) process.exit(0);

// Is VS Code on this machine at all: the app bundle, or the user-data dir it
// creates on first run. Deliberately not the `code` CLI — that's a PATH shim
// installed by hand from the command palette, so its absence says nothing
// about VS Code's.
if (!existsSync("/Applications/Visual Studio Code.app") && !existsSync(join(home, ".vscode"))) {
  console.log("vscode not detected, skipping plugin installation");
  process.exit(0);
}

// Drift is stated before the offer, and stays on screen whatever the answer
// is: the copy answers to whichever checkout last ran `npm install`, so which
// version is installed is the fact worth seeing, not just that a fix exists.
const missing = installed === null;
const notice = missing
  ? "vscode extension not installed."
  : `⚠ vscode extension installed is v${installed}, this checkout is v${mine}.`;

// Nobody to ask (piped, CI, a launchd job): say what was skipped and start.
if (!process.stdin.isTTY) {
  console.log(`${notice} run 'npm run ext:install' to ${missing ? "add" : "update"} it`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Ctrl+D at the prompt rejects rather than returning "" — and an unhandled
// rejection in a prestart takes `npm start` down with it, which is the daemon
// refusing to launch over an optional extension. EOF means no.
const answer = await rl
  .question(`${notice} ${missing ? "install" : "update"} it now? [Y/n] `)
  .then((a) => a.trim().toLowerCase())
  .catch(() => "n");
rl.close();
if (answer === "" || answer === "y" || answer === "yes") spawnSync("npm", ["run", "ext:install"], { stdio: "inherit" });
