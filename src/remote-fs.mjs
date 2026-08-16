import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tailLines, transcriptPathFor } from "./sessions.mjs";

// Where the pid list ends and the tar stream begins. Safe as a delimiter
// because everything before it is digits and newlines.
const SEPARATOR = "\n---\n";

/**
 * Call 1: this host's live pids and their parents, then its small files as a
 * tar stream.
 *
 * **`ps` first, `/proc` as the fallback** — the reverse of how this started. The
 * original reason for preferring `/proc` was that `ps` output formats vary and
 * an anchored `grep` rejected its right-padded columns; `awk` splits on
 * whitespace and made that moot. `ps` is now the primary because it is the one
 * that can produce the *second* column, and `/proc` cannot without parsing
 * `stat`, whose `comm` field can contain spaces and parentheses and so shifts
 * every field after it.
 *
 * That second column is the ancestry the terminal reveal joins on, fetched here
 * rather than at press time because a key press must never wait on ssh. A host
 * whose `ps` cannot produce it falls back to a pid-only listing: sessions stay
 * alive, and only the reveal is lost.
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
  // `| grep .` is the difference between "ps failed" and "ps said nothing".
  // Only the first falls through on exit status, and a `ps` that exits 0 with
  // empty output would otherwise take the pid set down with it — an empty set
  // is `isAlive` false for everything, so every session on that host silently
  // disappears rather than merely losing its terminal reveal.
  "{ ps -A -o pid=,ppid= 2>/dev/null | grep . || ls /proc 2>/dev/null; } | awk '$1 ~ /^[0-9]+$/ { print $1, $2 }'; " +
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
  if (at < 0) return { pids: new Set(), ppids: new Map(), tar: Buffer.alloc(0) };
  const pids = new Set();
  // Second column, when the host had a `ps` that could produce one. Absent is a
  // supported outcome, not a failure: it costs the terminal reveal for that
  // host and nothing else, where treating it as an error would drop every
  // session there as dead.
  const ppids = new Map();
  for (const line of buffer.subarray(0, at).toString("utf8").split("\n")) {
    const [first, second] = line.trim().split(/\s+/);
    const pid = Number(first);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    pids.add(pid);
    const ppid = Number(second);
    // pid 1's parent is 0, and a ppid of 0 would make `ancestorChain` walk to a
    // process that isn't one. Recorded only when it names a real parent.
    if (Number.isInteger(ppid) && ppid > 0) ppids.set(pid, ppid);
  }
  return { pids, ppids, tar: buffer.subarray(at + SEPARATOR.length) };
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
/**
 * Where each live session's context file is, on the host and in the tree.
 *
 * `ctx/<id>.json` is written by the remote's status line and is the only place a
 * session's context percentage exists — Claude Code hands that number to the
 * status line and nowhere else.
 *
 * **It is deliberately not in the tar.** `ctx/` accumulates one file per session
 * the host has ever run, and tar spends a 512-byte header on each: measured
 * locally, 118 files holding 1,775 bytes of content tarred to 360KB, against a
 * whole tree of 20KB. Asking call 2 for exactly the live sessions' files costs a
 * few hundred bytes and no extra round trip, since that call already takes a
 * path list.
 *
 * Filtering the tar by mtime instead was the other option and is worse: a
 * session can sit idle for days with a perfectly valid context file, and
 * `readContext`'s own contract says a stale file is fine because context cannot
 * change while nothing is happening.
 */
export function ctxTargets(liveSessions, root) {
  return liveSessions.map((s) => ({
    remote: join("", "ctx", `${s.sessionId}.json`),
    local: join(root, "ctx", `${s.sessionId}.json`),
  }));
}

/**
 * Land the fetched context files in the tree, where `readContext` already
 * looks. Best-effort per file: a context gauge is the least important thing on
 * a key, and a write that fails must not cost the session the rest of its
 * fetch.
 */
async function writeCtxFiles(targets, byRemote) {
  if (!targets.length) return;
  await mkdir(join(targets[0].local, ".."), { recursive: true }).catch(() => {});
  for (const t of targets) {
    const body = byRemote.get(t.remote);
    // A missing file comes back unknown — that host has no status line for this
    // session yet, which is an ordinary state and simply leaves the gauge off.
    if (!body?.lines.length) continue;
    await writeFile(t.local, body.lines.join("\n")).catch(() => {});
  }
}

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
 * Call 2: each transcript's last 64KB, with no size sent ahead of it — see
 * below for why not.
 *
 * Paths arrive on **stdin, one per line**, and are never interpolated into this
 * string. A cwd with a space or an apostrophe in it is an ordinary thing to
 * have, and would otherwise split the loop or unbalance a quote; the malicious
 * reading of the same hole is secondary to the accidental one.
 *
 * **The paths are relative to `~/.claude`, which is why the `cd` is here.** A
 * path read from stdin is data, and `~` is not expanded inside `"$f"` — sending
 * `~/.claude/projects/…` would make every `tail` miss, and every remote session
 * would silently lose its title. `cd` once, send relative paths.
 *
 * **Fields are NUL-delimited, and there is deliberately no length prefix.** An
 * earlier version sent `wc -c` before each tail and had the reader consume
 * exactly `min(size, TAIL_BYTES)` bytes. That is two reads of a live file: a
 * transcript under 64KB that grows between the `wc` and the `tail` makes `tail`
 * emit more bytes than the count promised, and every following file in the
 * batch is then read from the wrong offset — returning spliced garbage with
 * `whole: true` on it. The failure needs an actively-appending transcript,
 * which is the exact case this feature exists to show.
 *
 * A delimiter cannot desync, because the end of a field is marked rather than
 * computed. NUL is safe here: a transcript is JSONL, and JSON forbids an
 * unescaped control character — verified against the live host, zero NUL bytes
 * in 64KB of real transcript. ssh's stdout is 8-bit clean without a tty.
 *
 * **`whole` now comes from the bytes actually received**, not from a separate
 * size: fewer than `TAIL_BYTES` back means `tail` had nothing more to give, so
 * the window reached byte 0. Exactly `TAIL_BYTES` is reported not-whole, which
 * is conservative in the safe direction — a false `whole: false` only withholds
 * `startedEmpty`, while a false `whole: true` makes a busy session read `CLEAR`.
 */
export const TAILS_CMD =
  "cd ~/.claude 2>/dev/null || exit 0; " +
  `while IFS= read -r f; do tail -c ${TAIL_BYTES} "$f" 2>/dev/null; printf '\\0'; done`;

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
    const end = buffer.indexOf(0, at);
    // No terminator left: the stream stopped early. Unknown, not empty — the
    // same value tailLines returns for a read that failed.
    if (end < 0) {
      out.set(path, { lines: [], whole: false });
      continue;
    }
    const body = buffer.subarray(at, end);
    at = end + 1;
    // An empty field is a missing or empty file. Reported unknown rather than
    // "whole and empty": the only thing `whole` unlocks is startedEmpty, and
    // withholding it costs a CLEAR that would otherwise be right, where
    // granting it wrongly puts CLEAR on a session that is working.
    out.set(
      path,
      body.length === 0
        ? { lines: [], whole: false }
        : { lines: body.toString("utf8").split("\n"), whole: body.length < TAIL_BYTES }
    );
  }
  return out;
}

/**
 * Replace a host's tree with a freshly extracted one.
 *
 * `tar -xf` merges, and a merged tree keeps what the remote deleted. Only one of
 * the four things in there has a pid to check: a closed window's `ide/*.lock`
 * would linger and keep `matchFolder` matching a folder with no window —
 * silently defeating the invariant the whole join exists to enforce — and
 * `tasks/<id>/` would keep a finished session's list on the detail board.
 *
 * Renaming rather than removing-then-extracting also means a reader sees the old
 * complete tree or the new one, never a half-written one.
 */
export async function swapTree(stagingDir, finalDir) {
  const doomed = `${finalDir}.old`;
  await rm(doomed, { recursive: true, force: true });
  await rename(finalDir, doomed).catch(() => {}); // first fetch: nothing to move
  await rename(stagingDir, finalDir);
  await rm(doomed, { recursive: true, force: true });
}

function run(argv, { input, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => {
      clearTimeout(kill);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve(code === 0 ? Buffer.concat(chunks) : null);
    });
    child.stdin.on("error", () => {}); // a host that closed early is not a crash
    child.stdin.end(input ?? "");
  });
}

async function readJsonFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // partial write or corrupt file — skip it, not a crash
    }
  }
  return out;
}

/**
 * Everything one host contributes, as a source `getLiveSessions` can read.
 *
 * Two round trips, ~300ms warm. Returns `null` on any failure — a host that is
 * asleep, unreachable, or has never run Claude Code is an ordinary state, and
 * the caller drops its keys the way a closed window's are dropped.
 */
export async function fetchSource(host, scratchRoot) {
  const controlPath = join(scratchRoot, "cm-%h");
  const finalDir = join(scratchRoot, host);
  const staging = `${finalDir}.new`;

  // `remoteSources` (the only caller) awaits this with no try/catch of its own
  // — a rejection here would take the whole poll tick down, not just this
  // host's keys. Everything below is believed not to throw (ssh/tar failures
  // resolve through `run`, not reject), but this outer guard is what makes
  // that a fact rather than an assumption a rare EACCES/ENOSPC could break.
  try {
    // ssh's ControlPath is a socket bind, not a file write: with no directory
    // yet to bind it in, ssh exits 255 before it ever reaches the network —
    // measured against the live host on a fresh scratch root, the daemon's
    // actual first run every time. `run()` reports that exit like any other
    // failure, so this has to exist before the first call, not be inferred
    // from one failing.
    await mkdir(scratchRoot, { recursive: true });

    const stream = await run(["ssh", ...sshArgs(host, controlPath), TREE_CMD]);
    if (!stream) return null;
    const { pids, ppids, tar } = splitTreeStream(stream);

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    // No `-P`: without it both GNU tar and bsdtar strip a leading `/` and
    // refuse `..` members, so a stream cannot write outside the tree. `-P`
    // would disable exactly that — it is the flag to *not* reach for here.
    const extracted = await run(["tar", "-xf", "-", "-C", staging], { input: tar });
    if (extracted === null) {
      await rm(staging, { recursive: true, force: true });
      return null;
    }
    await swapTree(staging, finalDir);

    // The registry is now on local disk, so the daemon resolves transcript
    // paths itself — with the same functions it uses locally — rather than
    // asking the remote to know which files matter.
    const registry = await readJsonFiles(join(finalDir, "sessions"));
    // The remote path is relative to ~/.claude, because TAILS_CMD `cd`s there
    // first: a path read from stdin is data, and `~` is not expanded inside
    // "$f". The local path is the same file inside the fetched tree, and is
    // what the injected `tail` will be asked for — `sessionsFrom` resolves it
    // with this same function against the source's root.
    const liveSessions = registry.filter((s) => s.sessionId && s.cwd && pids.has(s.pid));
    const wanted = liveSessions.map((s) => ({
      local: transcriptPathFor({ cwd: s.cwd, sessionId: s.sessionId }, finalDir),
      remote: transcriptPathFor({ cwd: s.cwd, sessionId: s.sessionId }, ""),
    }));
    const ctx = ctxTargets(liveSessions, finalDir);

    // ponytail: every due tail is refetched in full each cycle, whether or not
    // it changed since the last fetch — fine at REMOTE_POLL_MS against a
    // handful of sessions. Upgrade path if a WAN link or a busier Pi
    // complains: send the previously seen `{path: mtime}` alongside the
    // request so an unchanged tail comes back empty and is served from what
    // was already parsed, instead of re-sent.
    // Transcripts and context files travel in the same call: it already takes a
    // path list, so adding to it costs no round trip. They are used differently
    // at the far end — a transcript is served to the injected `tail`, a context
    // file is written into the tree — but the wire is the same.
    let tails = new Map();
    const all = [...wanted, ...ctx];
    if (all.length) {
      const body = await run(["ssh", ...sshArgs(host, controlPath), TAILS_CMD], {
        input: all.map((w) => w.remote).join("\n") + "\n",
      });
      if (body) {
        const byRemote = parseTails(body, all.map((w) => w.remote));
        for (const w of wanted) tails.set(w.local, byRemote.get(w.remote));
        // Written to disk rather than kept in the map, so `readContext` stays
        // exactly the local reader it already is — it takes a root and a
        // session id and knows nothing about sources. A context file is a
        // single short JSON line, so a "tail" of it is the whole thing.
        await writeCtxFiles(ctx, byRemote);
      }
    }

    return {
      host,
      root: finalDir,
      isAlive: (pid) => pids.has(pid),
      // This host's pid -> ppid table, so a session's ancestor chain can be
      // computed during the poll. The press that uses it happens inside a
      // synchronous key handler and cannot afford an ssh round trip; empty on a
      // host whose `ps` gave no second column, which costs only the reveal.
      ppids,
      // A session transcript was never fetched to disk, so it comes from the
      // map. A *subagent* transcript did ride in the tar — small, and needed
      // with its real mtime, since SUBAGENT_IDLE_MAX_S retires an agent by
      // how long it has been quiet — so it is read off the tree like any
      // local file. Without this fallback `readRunningSubagents` asks for a
      // path the map has never heard of, gets the failure value, and no
      // remote session ever shows a subagent.
      tail: async (path) => tails.get(path) ?? tailLines(path),
    };
  } catch {
    // Same failure value as an unreachable host: whatever partial state was
    // left in `staging`/`finalDir` is cleaned up or overwritten by the next
    // attempt, which starts with the same `rm(staging, {force: true})` above.
    return null;
  }
}
