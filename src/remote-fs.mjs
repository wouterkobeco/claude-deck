import { spawn } from "node:child_process";

// Where the pid list ends and the tar stream begins. Safe as a delimiter
// because everything before it is digits and newlines.
const SEPARATOR = "\n---\n";

/**
 * Call 1: this host's live pids, then its small files as a tar stream.
 *
 * `/proc` rather than `ps`, so nothing has to know which `ps` the host ships or
 * how it formats columns; `ps -A -o pid=` is the fallback for a remote without
 * `/proc`.
 *
 * **The member list is built positively with `find`, not by excluding a glob.**
 * Two facts force this, both measured against a real host:
 *
 * 1. `tar --exclude` matches with `fnmatch` and *no* `FNM_PATHNAME`, so `*`
 *    crosses `/`. `--exclude='projects/*​/*.jsonl'` therefore also drops
 *    `projects/<slug>/<id>/subagents/agent-*.jsonl` four levels down — the
 *    files `readRunningSubagents` reads. Nothing errors; remote sessions simply
 *    never show a subagent again. The anchored BRE below cannot do this:
 *    `[^/]*` provably does not cross `/`.
 * 2. Excluding only the *live* sessions' transcripts is not enough. A project
 *    directory holds every transcript it has ever had — this host carries a
 *    4.3MB one from a session that ended days ago. The rule has to be "no
 *    depth-2 transcript", not "not these ones".
 *
 * Measured on the live host: 20KB with this list, 4.7MB without it.
 *
 * Subagent transcripts ride along in the tar, with their real mtimes — which
 * `readRunningSubagents` needs, since `SUBAGENT_IDLE_MAX_S` retires an agent
 * that stopped writing. That is why they are not fetched as tails instead.
 *
 * A missing `~/.claude` exits 0 with an empty stream rather than failing: a host
 * you have opened a window on but never run Claude Code on is an ordinary state,
 * not an error.
 */
export const TREE_CMD =
  "cd ~/.claude 2>/dev/null || exit 0; " +
  "{ ls /proc 2>/dev/null || ps -A -o pid= 2>/dev/null; } | grep -E '^[0-9]+$'; " +
  "echo ---; " +
  "{ find sessions ide tasks -type f 2>/dev/null; " +
  '  find projects -type f 2>/dev/null | grep -v "^projects/[^/]*/[^/]*\\.jsonl$"; ' +
  "} | tar -cf - -T - 2>/dev/null";

/**
 * Split call 1's stream into the pid set and the tar bytes.
 *
 * Only the *first* separator splits: the tar payload is arbitrary binary and
 * can contain the same three bytes. Anything unparseable yields empties — this
 * runs against another machine's output on a link that can drop.
 */
export function splitTreeStream(buffer) {
  const at = buffer.indexOf(SEPARATOR);
  if (at < 0) return { pids: new Set(), tar: Buffer.alloc(0) };
  const pids = new Set();
  for (const line of buffer.subarray(0, at).toString("utf8").split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return { pids, tar: buffer.subarray(at + SEPARATOR.length) };
}

/**
 * Arguments for every call to a host.
 *
 * `ControlMaster`/`ControlPersist` are what make this affordable: a cold
 * connection is ~600ms, a warm multiplexed one ~20ms. `BatchMode` guarantees it
 * never blocks on a passphrase prompt in a daemon with no terminal.
 *
 * The host goes last and after `--`. `validHost` already rejects a leading
 * dash; this is the second half of that guard, because a host that reached ssh
 * as `-oProxyCommand=…` would run a command on *this* machine.
 */
export function sshArgs(host, controlPath) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=60",
    "--",
    host,
  ];
}

// Kept in step with sessions.mjs's TAIL_BYTES. Both describe the same window.
const TAIL_BYTES = 65536;

/**
 * Call 2: the true byte size of each transcript, then its last 64KB.
 *
 * Paths arrive on **stdin, one per line**, and are never interpolated into this
 * string. A cwd with a space or an apostrophe in it is an ordinary thing to
 * have, and would otherwise split the loop or unbalance a quote; the malicious
 * reading of the same hole is secondary to the accidental one.
 *
 * **The paths are relative to `~/.claude`, which is why the `cd` is here.** A
 * path read from stdin is data, and `~` is not expanded inside `"$f"` — sending
 * `~/.claude/projects/…` would make every `wc` and `tail` miss, and every remote
 * session would silently lose its title. `cd` once, send relative paths.
 *
 * `wc -c` before `tail` is the frame *and* the answer to `whole`: the size is
 * the file's, the payload is at most the tail window, and the two together say
 * whether the window reached byte 0. Reconstructing that here from a byte offset
 * is what this design exists to avoid.
 */
export const TAILS_CMD =
  "cd ~/.claude 2>/dev/null || exit 0; " +
  'while IFS= read -r f; do wc -c < "$f" 2>/dev/null || echo 0; tail -c 65536 "$f" 2>/dev/null; done';

/**
 * Read call 2's stream back into one `{ lines, whole }` per requested path, in
 * the order they were requested.
 *
 * Shaped to match `tailLines` exactly, including its failure value: a read that
 * failed reports `{ lines: [], whole: false }` — unknown, not empty. A stream
 * that stopped early leaves every remaining path unknown for the same reason.
 */
export function parseTails(buffer, paths) {
  const out = new Map();
  let at = 0;
  for (const path of paths) {
    const nl = buffer.indexOf("\n", at);
    if (nl < 0) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    const size = Number(buffer.subarray(at, nl).toString("utf8").trim());
    at = nl + 1;
    if (!Number.isInteger(size) || size <= 0) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    const expected = Math.min(size, TAIL_BYTES);
    const body = buffer.subarray(at, at + expected);
    if (body.length < expected) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    at += expected;
    out.set(path, { lines: body.toString("utf8").split("\n"), whole: size <= TAIL_BYTES });
  }
  return out;
}
