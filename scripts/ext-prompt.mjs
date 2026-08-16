// `npm start`'s prestart: offer to install the VS Code extension when it isn't
// there.
//
// The extension normally rides in on `npm install`'s postinstall, so this only
// fires for the cases that miss it — a checkout whose install predates the
// extension, a copy deleted since, or a `~/.vscode/extensions` slot another
// worktree overwrote and then removed. Its absence is silent by design (a
// window without it simply doesn't reveal terminals), and `npm start` is the
// one moment a person is definitely watching.
//
// Never fatal: every path here exits 0. A prestart that can fail the daemon it
// precedes is a worse trade than a missing extension.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
if (existsSync(join(home, ".vscode/extensions/claude-streamdeck-terminal-focus"))) process.exit(0);

// Is VS Code on this machine at all: the app bundle, or the user-data dir it
// creates on first run. Deliberately not the `code` CLI — that's a PATH shim
// installed by hand from the command palette, so its absence says nothing
// about VS Code's.
if (!existsSync("/Applications/Visual Studio Code.app") && !existsSync(join(home, ".vscode"))) {
  console.log("vscode not detected, skipping plugin installation");
  process.exit(0);
}

// Nobody to ask (piped, CI, a launchd job): say what was skipped and start.
if (!process.stdin.isTTY) {
  console.log("vscode extension not installed — run 'npm run ext:install' to add it");
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Ctrl+D at the prompt rejects rather than returning "" — and an unhandled
// rejection in a prestart takes `npm start` down with it, which is the daemon
// refusing to launch over an optional extension. EOF means no.
const answer = await rl
  .question("vscode extension not installed. install it now? [Y/n] ")
  .then((a) => a.trim().toLowerCase())
  .catch(() => "n");
rl.close();
if (answer === "" || answer === "y" || answer === "yes") spawnSync("npm", ["run", "ext:install"], { stdio: "inherit" });
