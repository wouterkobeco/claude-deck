// Installs the status line a remote host needs before its sessions can show a
// context gauge. Manual and explicit: `npm run remote:install -- <host>`.
//
// This is the one thing in the project that writes to a machine other than this
// one, which is why it is a command you run rather than anything the daemon
// does. It is never wired into `postinstall` — `npm install` reaching across
// ssh to edit another machine's config is not a trade this project makes.
//
// Why it is needed at all: Claude Code hands a session's context percentage to
// the status line and nowhere else. `~/.claude/ctx/<id>.json` is a side channel
// the status line writes for the daemon to read, and a host without one simply
// has no context to report — the gauge stays off, which is exactly what happens
// on a local machine without a status line.
//
// Refuses rather than overwrites, in every case where something is already
// there. A status line is a thing the user sees on every turn, and silently
// replacing one to add a gauge to a Stream Deck key is not a fair trade.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validHost } from "../src/window-state.mjs";
import { sshArgs } from "../src/remote-fs.mjs";

const execFileAsync = promisify(execFile);
const LOCAL_STATUSLINE = join(homedir(), ".claude", "statusline-command.sh");

// The block the README documents, on its own, for a host where there is no
// local status line to copy. Deliberately minimal: it exists to feed the gauge,
// not to decide what someone's status line should say.
const MINIMAL = `#!/usr/bin/env bash
# Claude Code status line, installed by claude-streamdeck's remote:install.
input=$(cat)

# Side-channel for the claude-streamdeck daemon: it has no other way to learn a
# session's context usage, and the percentage here is measured against the real
# window size (1M on some models, 200k on others) rather than a guess.
# Written via a temp file so the daemon never reads a half-written one.
ctx_dir="$HOME/.claude/ctx"
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ]; then
  mkdir -p "$ctx_dir"
  echo "$input" | jq -c '{context: .context_window.used_percentage}' > "$ctx_dir/$sid.json.tmp" &&
    mv "$ctx_dir/$sid.json.tmp" "$ctx_dir/$sid.json"
fi

printf '%s' "$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')"
`;

const host = validHost(process.argv[2]);
if (!host) {
  console.error("usage: npm run remote:install -- <host>");
  console.error("       <host> is an ssh target, the same one the deck shows for that window.");
  if (process.argv[2]) console.error(`\nrefused ${JSON.stringify(process.argv[2])}: not a plain hostname.`);
  process.exit(1);
}

const ssh = (command, input) =>
  execFileAsync("ssh", [...sshArgs(host, join("/tmp", `streamdeck-install-${process.pid}`)), command], {
    input,
    maxBuffer: 8 * 1024 * 1024,
  });

async function main() {
  // Everything this needs to know about the host, in one round trip, before
  // anything is written.
  const { stdout } = await ssh(
    'printf "jq=%s\\n" "$(command -v jq || echo NONE)"; ' +
      'printf "script=%s\\n" "$([ -e ~/.claude/statusline-command.sh ] && echo YES || echo NO)"; ' +
      'printf "key=%s\\n" "$(jq -r \'if has("statusLine") then "YES" else "NO" end\' ~/.claude/settings.json 2>/dev/null || echo UNKNOWN)"'
  );
  const state = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split("=")));

  if (state.jq === "NONE") {
    console.error(`${host}: no jq. The status line block parses Claude Code's JSON with it; install jq and re-run.`);
    process.exit(1);
  }
  if (state.script === "YES") {
    console.error(`${host}: ~/.claude/statusline-command.sh already exists — not overwriting it.`);
    console.error("Add the block from README.md's context-gauge section to it by hand instead.");
    process.exit(1);
  }
  if (state.key === "YES") {
    console.error(`${host}: settings.json already sets statusLine — not replacing it.`);
    console.error("Add the block from README.md's context-gauge section to whatever it points at.");
    process.exit(1);
  }

  // Prefer this machine's own status line, so the remote's looks like the one
  // you already read every day rather than something this script invented. It
  // is plain bash + jq + git, which is why copying it is safe.
  let body = MINIMAL;
  let source = "the minimal block (no local status line to copy)";
  try {
    body = await readFile(LOCAL_STATUSLINE, "utf8");
    source = LOCAL_STATUSLINE;
    if (!body.includes("ctx_dir")) {
      console.error(`${LOCAL_STATUSLINE} has no ctx block — the gauge would not work on the remote either.`);
      console.error("Add the block from README.md's context-gauge section locally first, then re-run.");
      process.exit(1);
    }
  } catch {
    // no local status line — MINIMAL it is
  }

  // Written via a temp file and moved into place, the same way the block itself
  // writes ctx files: a status line read while half-written would break every
  // turn on that host until the next write.
  await ssh(
    'mkdir -p ~/.claude && cat > ~/.claude/statusline-command.sh.tmp && ' +
      "chmod +x ~/.claude/statusline-command.sh.tmp && " +
      "mv ~/.claude/statusline-command.sh.tmp ~/.claude/statusline-command.sh",
    body
  );

  // jq rather than a rewrite, so everything else in settings.json survives
  // untouched — that file holds plugins, theme, and whatever else that host
  // has, none of which is ours to reformat.
  await ssh(
    'cd ~/.claude && { [ -e settings.json ] || echo "{}" > settings.json; } && ' +
      'jq \'.statusLine = {"type": "command", "command": "~/.claude/statusline-command.sh"}\' settings.json > settings.json.tmp && ' +
      "mv settings.json.tmp settings.json"
  );

  console.log(`${host}: status line installed from ${source}`);
  console.log("Its context gauge appears once that host writes its first ctx file — a session there has to take a turn.");
}

main().catch((err) => {
  console.error(`${host}: install failed:`, err.stderr?.trim() || err.message);
  process.exit(1);
});
