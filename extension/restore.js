// Which published sessions are this window's, and which of those are worth
// offering to restore. Split out of extension.js for the same reason
// routing.js is: that file cannot be loaded outside a running editor, and this
// is the part where being wrong is invisible — an over-broad filter restores
// another window's sessions into yours, and a bad id is a string this
// extension types into a shell.

// A session id is a UUID. It is checked rather than trusted because it does not
// originate here: the daemon reads it from a session registry, and for a remote
// window that registry belongs to the other machine — a host that chooses its
// own session ids also chooses what `claude --resume <id>` expands to in your
// terminal. Refuse rather than sanitise, the same call `isPathSafeId` makes on
// the daemon side: a real id has no room for a shell metacharacter, so one that
// contains any is not a session id that needs rescuing.
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// A tmux session name reaches the same shell (`tmux attach -t <name>`), and is
// whatever the other machine's user typed after `tmux new -s`. Ordinary names
// only; anything else is treated as not in tmux rather than quoted.
const TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The rows in `~/.claude/streamdeck-sessions.json` that belong to this window.
 *
 * `folders` is the window's folder paths (`f.uri.fsPath`), `host` is what
 * `sshHost()` returned for it — `null` for a local window, and compared rather
 * than assumed so a local window can never claim a remote host's rows, whose
 * paths may well be identical to its own.
 *
 * Matching is on `folder`, not `cwd`: the daemon has already resolved a
 * worktree or subdirectory session to the window folder that owns it, which is
 * the join this side has no way to redo.
 */
function sessionsForWindow(rows, folders, host) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        SESSION_ID_RE.test(r.id) &&
        typeof r.cwd === "string" &&
        r.cwd &&
        (r.host ?? null) === (host ?? null) &&
        folders.includes(r.folder)
    )
    .map((r) => ({
      id: r.id,
      cwd: r.cwd,
      title: typeof r.title === "string" && r.title ? r.title : null,
      tmux: typeof r.tmux === "string" && TMUX_NAME_RE.test(r.tmux) ? r.tmux : null,
      attached: typeof r.attached === "boolean" ? r.attached : null,
    }));
}

/**
 * What to offer after a restart: everything this window had, minus whatever is
 * running right now.
 *
 * The subtraction is the point. The snapshot is written while sessions are
 * alive and read after they are gone, so on an ordinary reload — where the
 * terminals survived — every row is still live and the picker is correctly
 * empty. It also stops a second run of the command from opening a second copy
 * of everything the first one just restored.
 */
function toRestore(saved, live) {
  const running = new Set(live.map((s) => s.id));
  // A session still running in a tmux nobody is attached to outlived its
  // terminal: offered as a reattach, not a resume. `attached: null` is
  // "couldn't ask", which must not offer a second view of a session on screen.
  const detached = live.filter((s) => s.tmux && s.attached === false).map((s) => ({ ...s, reattach: true }));
  return [...saved.filter((s) => !running.has(s.id)), ...detached];
}

/**
 * What to type into the restored terminal. One place, so the id can never
 * reach a shell without passing SESSION_ID_RE on the way — `sessionsForWindow`
 * is the only producer of these rows, and this throws rather than quietly
 * dropping the check if that ever stops being true.
 */
function resumeCommand(id) {
  if (!SESSION_ID_RE.test(id)) throw new Error(`not a session id: ${id}`);
  return `claude --resume ${id}`;
}

/**
 * The whole line for one restore row: reattach a detached tmux session, resume
 * a session that was in tmux back into a fresh one, or plain resume.
 *
 * The fresh tmux one types the resume into the new session's own shell rather
 * than handing it to `tmux new-session` as a command: that runs under `sh -c`,
 * which never reads the rc file that puts `claude` on PATH. Started detached
 * so `send-keys` has a target, then attached.
 */
function restoreCommand(s) {
  if (s.tmux && !TMUX_NAME_RE.test(s.tmux)) throw new Error(`not a tmux session name: ${s.tmux}`);
  if (s.reattach) return `tmux attach -t ${s.tmux}`;
  const resume = resumeCommand(s.id);
  if (!s.tmux) return unlessRunning(s.id, resume);
  return unlessRunning(
    s.id,
    `t=$(tmux new-session -dP -F '#{session_name}') && tmux send-keys -t "$t" '${resume}' Enter && tmux attach -t "$t"`
  );
}

/**
 * `fresh`, unless a live process on this machine already holds the id.
 *
 * The deck's list is no proof a session is gone: a host it couldn't fetch, or
 * a window that opened before its first fetch, publishes nothing, and every
 * remembered session then reads as dead. Measured on BEAST: three restores in
 * that state left one conversation in four processes, each believing it was
 * the coordinator. So the line asks the host's own registry at the moment it
 * runs — the terminal is on that host — and a live holder is reattached when
 * it sits in tmux, left alone when it doesn't. A cmux pane's `tmux` field is
 * not a tmux session, and the name class keeps anything odd out of `attach`.
 *
 * `id` is already through SESSION_ID_RE (resumeCommand), so it is safe inside
 * the single-quoted grep pattern.
 */
function unlessRunning(id, fresh) {
  const find = `f=; for p in $(grep -rlF '"sessionId":"${id}"' ~/.claude/sessions 2>/dev/null); do kill -0 "$(basename "$p" .json)" 2>/dev/null && f=$p && break; done`;
  const name = `t=$(sed -n 's/.*"tmux":"\\([A-Za-z0-9_-]*\\):.*/\\1/p' "$f")`;
  const busy = `echo "claude: ${id} is already running (pid $(basename "$f" .json)), not starting a second copy"`;
  return `${find}; if [ -z "$f" ]; then ${fresh}; else ${name}; if [ -n "$t" ] && [ "$t" != cmux ]; then tmux attach -t "$t"; else ${busy}; fi; fi`;
}

module.exports = { sessionsForWindow, toRestore, resumeCommand, restoreCommand, SESSION_ID_RE };
