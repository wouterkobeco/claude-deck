// `npm start`'s prestart, and `npm run ext:install` with `--yes`: keep
// ~/.vscode/extensions in step with this checkout, and ask for the window
// reload *only* when a reload would actually change something.
//
// The extension normally rides in on `npm install`'s postinstall, so the prompt
// only fires for the cases that miss it — a checkout whose install predates the
// extension, a copy deleted since, or a `~/.vscode/extensions` slot another
// worktree overwrote (that one is a *drift*, not an absence: most work here
// happens in worktrees and there is only one extensions slot). Neither shows up
// anywhere by design — a window without the extension simply doesn't reveal
// terminals — and `npm start` is the one moment a person is definitely
// watching.
//
// **The question is content, not version.** The two package.json versions are
// bumped together on every release (terminal-focus-check enforces it) and the
// extension is 9 commits out of 181: v1.1.29 bumped extension/package.json with
// no change to a single .js file, and still asked for every open window to be
// reloaded. A reload prompt that is usually noise is a reload prompt nobody
// reads. So the stamp still moves in lockstep — it is how you tell by eye which
// version is in the slot — but it is copied *quietly*, and the drift notice and
// the reload advice are kept for the case where VS Code would really run
// different code.
//
// Never fatal: every path here exits 0. A prestart that can fail the daemon it
// precedes is a worse trade than a missing extension.
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = homedir();
const installedDir = join(home, ".vscode/extensions/claude-streamdeck-terminal-focus");
const sourceDir = fileURLToPath(new URL("../extension", import.meta.url));
const forced = process.argv.includes("--yes");

// null covers both "not installed" and "installed but unreadable" — the fix is
// the same copy either way, so they don't need telling apart.
const versionOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
};

/**
 * What VS Code would actually run, as one string.
 *
 * The version is stripped from package.json because that is the field that
 * moves for reasons that have nothing to do with this extension — it tracks the
 * daemon. Everything else in the manifest stays in: `contributes`,
 * `activationEvents` and `extensionKind` all change behaviour and all need the
 * window reloaded. `.md` files are left out for the opposite reason: nothing
 * loads them, so a doc fix must not ask fifteen windows to restart.
 */
const signature = (dir) => {
  try {
    const hash = createHash("sha1");
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".md")) continue;
      const body = readFileSync(join(dir, name), "utf8");
      hash.update(`${name}\0`);
      hash.update(name === "package.json" ? body.replace(/"version"\s*:\s*"[^"]*",?/, "") : body);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
};

const install = () => {
  // rm first, not a merge: a file this checkout deleted has to leave the slot
  // too, or the window keeps loading it.
  rmSync(installedDir, { recursive: true, force: true });
  cpSync(sourceDir, installedDir, { recursive: true });
};

const installed = versionOf(installedDir);
const mine = versionOf(sourceDir);

// Nothing VS Code runs has changed, whatever the stamps say.
if (signature(installedDir) === signature(sourceDir)) {
  // Re-stamp anyway, silently: `code --list-extensions --show-versions` and the
  // Extensions view read that number off disk, and it is the whole "which
  // version is in the slot?" check. It is a copy of identical code with a new
  // number on it, so there is nothing here to ask about and nothing to reload.
  if (installed !== mine) {
    try {
      install();
    } catch {
      // The slot is already running code identical to this checkout's; a failed
      // re-stamp costs an accurate version number and nothing else.
    }
  }
  // Only when asked directly (`ext:install`, postinstall). Silence is right for
  // the prestart, and wrong for a command someone typed — that reads as broken.
  if (forced) console.log(`extension already current (v${mine}) — nothing to reload`);
  process.exit(0);
}

// Is VS Code on this machine at all: the app bundle, or the user-data dir it
// creates on first run. Deliberately not the `code` CLI — that's a PATH shim
// installed by hand from the command palette, so its absence says nothing
// about VS Code's. Skipped under --yes, which is `ext:install`/postinstall:
// that has always installed unconditionally, and an `npm install` that fails
// over a missing ~/.vscode is the one outcome worth avoiding here.
if (!forced && !existsSync("/Applications/Visual Studio Code.app") && !existsSync(join(home, ".vscode"))) {
  console.log("vscode not detected, skipping plugin installation");
  process.exit(0);
}

// Drift is stated before the offer, and stays on screen whatever the answer
// is: the copy answers to whichever checkout last ran `npm install`, so which
// version is installed is the fact worth seeing, not just that a fix exists.
const missing = installed === null;
const notice = missing
  ? "vscode extension not installed."
  : `⚠ vscode extension installed is v${installed}, this checkout is v${mine} — and its code differs.`;

// Nobody to ask (piped, CI, a launchd job): say what was skipped and start.
if (!forced && !process.stdin.isTTY) {
  console.log(`${notice} run 'npm run ext:install' to ${missing ? "add" : "update"} it`);
  process.exit(0);
}

const rl = forced ? null : createInterface({ input: process.stdin, output: process.stdout });
// Ctrl+D at the prompt rejects rather than returning "" — and an unhandled
// rejection in a prestart takes `npm start` down with it, which is the daemon
// refusing to launch over an optional extension. EOF means no.
const answer = forced
  ? "y"
  : await rl
      .question(`${notice} ${missing ? "install" : "update"} it now? [Y/n] `)
      .then((a) => a.trim().toLowerCase())
      .catch(() => "n");
rl?.close();
// Yes is the default in both directions, the same as statusline-prompt.mjs
// beside it: Enter takes it, and so does anything that isn't an explicit no.
// These two run back to back, and a prompt that answers differently from the
// one before it is the kind of thing you only notice by installing nothing.
if (answer === "n" || answer === "no") process.exit(0);

try {
  install();
  // Earned, this time: the copy on disk really does differ from what any open
  // window loaded at startup, and nothing but a reload picks it up.
  console.log("extension installed — run 'Developer: Reload Window' in VS Code windows already open");
} catch (err) {
  console.log(`extension install failed (${err.message}) — run 'npm run ext:install' by hand`);
}
