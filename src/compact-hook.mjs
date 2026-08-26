// The second thing this project asks you to install by hand: PreCompact and
// PostCompact hooks, so an *auto*-triggered compaction shows on the deck too.
//
// A manual /compact already works without this — the command line itself is
// the marker `sessions.mjs` reads out of the transcript. An auto-triggered
// compaction writes nothing until it is already over (the `compact_boundary`
// record), and nothing else in the transcript, the registry's `status`, or
// any other subtype Claude Code writes says "compaction starting" ahead of
// that — checked directly against a real one (`away_summary`, `local_command`,
// `stop_hook_summary`, `turn_duration`, `compact_boundary`, nothing else).
// PreCompact/PostCompact are the one place that moment is observable at all,
// for both trigger types alike.
//
// What lives here is the hook script and the *decision* about whether a
// machine needs it — pure, so a check can drive it against fixtures, the same
// split `statusline.mjs` makes. The thing that actually writes it is a
// command: `scripts/compact-hook-prestart.mjs` for this machine (offered at
// `npm start`), `scripts/remote-install.mjs` for a remote host.
//
// Unlike the status line, there is nothing here to refuse: `hooks.PreCompact`
// and `hooks.PostCompact` are arrays every Claude Code hook adds an entry to
// rather than a single slot one command owns, so installing this can never
// clobber a hook you already had — it only ever adds one more entry, and does
// nothing if that entry is already there.

// Where the marker lands, and the only thing this hook writes: a session's
// compaction start time, cleared the instant compaction ends. Read back by
// `readCompactMarker` in sessions.mjs, and — for a remote host — fetched
// alongside `ctx/` by `compactTargets`/`writeCompactFiles` in remote-fs.mjs.
export const MARKER_DIR = "streamdeck-compact";

// Grep+sed rather than jq: the payload only ever needs two flat top-level
// string fields, and this way the hook has no dependency for `decide` to
// gate on the way the status line gates on jq. `printf '%s'` rather than
// `echo` so a session id or event name that happened to start with `-`
// couldn't be read as a flag.
export const HOOK_SCRIPT = `#!/bin/sh
# PreCompact/PostCompact hook installed by claude-streamdeck. See
# src/compact-hook.mjs for why this exists.
input=$(cat)
sid=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\\([^"]*\\)"$/\\1/')
event=$(printf '%s' "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\\([^"]*\\)"$/\\1/')
[ -n "$sid" ] || exit 0
dir="$HOME/.claude/${MARKER_DIR}"
mkdir -p "$dir"
if [ "$event" = "PreCompact" ]; then
  printf '{"at":%s000}\\n' "$(date +%s)" > "$dir/$sid.json.tmp" && mv "$dir/$sid.json.tmp" "$dir/$sid.json"
else
  rm -f "$dir/$sid.json"
fi
`;

export const SCRIPT_NAME = "streamdeck-compact-hook.sh";

// `~/...`, matching the exact style `statusLine.command` already uses and is
// known to resolve correctly when Claude Code runs a hook command.
export const HOOK_COMMAND = `~/.claude/${SCRIPT_NAME}`;

/** Whether one event's hook-group array already runs our command. */
export function hasHook(entries) {
  return Array.isArray(entries) && entries.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === HOOK_COMMAND));
}

function withHookEvent(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!hasHook(list)) list.push({ matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  return list;
}

/**
 * `settings.json` with our two hook entries added — additively, never
 * replacing anything that was already registered for either event, and
 * idempotent, since `npm start` calls this every launch once the script is
 * out of date for any reason.
 */
export function withHooksInstalled(settings) {
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      PreCompact: withHookEvent(settings.hooks?.PreCompact),
      PostCompact: withHookEvent(settings.hooks?.PostCompact),
    },
  };
}

/**
 * What this machine needs, from what one probe found.
 *
 *   ok      — the script is current and both hooks are wired, say nothing
 *   install — the script is missing/stale, or either hook is missing
 *
 * No `manual`/`nojq`/`append`: unlike the status line there is no existing
 * file whose shape this has to reason about and no single slot to conflict
 * over, so every machine either already has this or can just get it.
 */
export function decide({ script, hooks }) {
  if (script === HOOK_SCRIPT && hasHook(hooks?.PreCompact) && hasHook(hooks?.PostCompact)) return "ok";
  return "install";
}
