// The one thing this project asks you to install by hand: the status line block
// that feeds the context gauge.
//
// Claude Code hands a session's context percentage to the status line and
// nowhere else, so `~/.claude/ctx/<id>.json` is a side channel the status line
// writes for the daemon to read. Everything else here degrades to nothing on
// its own; this needs a file the daemon is not allowed to own.
//
// What lives here is the block, and the *decision* about what a machine needs —
// pure, so `statusline-check` can drive it against fixtures. The two things
// that actually write it are commands: `scripts/statusline-prompt.mjs` for this
// machine (offered at `npm start`) and `scripts/remote-install.mjs` for a
// remote host. Neither may overwrite a status line someone wrote: it is read on
// every turn, and replacing one to feed a gauge on a key is not a fair trade.

// Written via a temp file so the daemon never reads a half-written one.
export const CTX_BLOCK = `# Side-channel for the claude-streamdeck daemon: it has no other way to learn a
# session's context usage, and the percentage here is measured against the real
# window size (1M on some models, 200k on others) rather than a guess.
ctx_dir="$HOME/.claude/ctx"
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ]; then
  mkdir -p "$ctx_dir"
  echo "$input" | jq -c '{context: .context_window.used_percentage}' > "$ctx_dir/$sid.json.tmp" &&
    mv "$ctx_dir/$sid.json.tmp" "$ctx_dir/$sid.json"
fi`;

// A whole status line, for a machine that has none. Deliberately minimal: it
// exists to feed the gauge, not to decide what someone's status line says.
export const MINIMAL = `#!/usr/bin/env bash
# Claude Code status line, installed by claude-streamdeck.
input=$(cat)

${CTX_BLOCK}

printf '%s' "$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')"
`;

// The path the README documents and the only one either installer touches.
export const SCRIPT_NAME = "statusline-command.sh";

/**
 * Put the block into an existing status line, after the line that reads stdin.
 *
 * After `input=$(cat)` rather than at the end, which is what the README has
 * always said: the block needs `$input`, and appending is silently dead in a
 * script that ends in an `exit`. Returns null when there is no such line —
 * a status line that reads stdin some other way is one to leave alone and
 * describe, not one to guess at.
 *
 * This is also the only definition of "can this be appended to": `decide`
 * asks by calling it, so the two can't drift apart.
 */
export function insertBlock(script, block = CTX_BLOCK) {
  const lines = script.split("\n");
  const at = lines.findIndex((l) => /^\s*input=\$\(cat\)\s*$/.test(l));
  if (at === -1) return null;
  lines.splice(at + 1, 0, "", block);
  return lines.join("\n");
}

/**
 * What this machine needs, from what one probe found.
 *
 * `script` is the content of `~/.claude/statusline-command.sh`, or null when it
 * is missing *or empty* — a zero-byte one is a placeholder, a truncated write
 * or a `touch`, and refusing to install over it protects nothing while blocking
 * the one thing that would fix it. (That is not hypothetical; see
 * remote-install.mjs' `-s` note.) `statusLine` is settings.json's command
 * string, or null.
 *
 *   ok      — the block is already there, say nothing
 *   nojq    — the block parses JSON with jq and there is none
 *   install — nothing here at all: write MINIMAL and point settings.json at it
 *   append  — a status line of your own, with somewhere to put the block
 *   manual  — a status line this can't reason about: print the block, touch nothing
 */
export function decide({ jq, script, statusLine }) {
  if (script?.includes("ctx_dir")) return "ok";
  if (!jq) return "nojq";
  // settings.json pointing somewhere else means the file above is not the one
  // being run, so editing it would change nothing and say it had.
  if (statusLine && !statusLine.includes(SCRIPT_NAME)) return "manual";
  if (!script) return "install";
  return insertBlock(script) === null ? "manual" : "append";
}
