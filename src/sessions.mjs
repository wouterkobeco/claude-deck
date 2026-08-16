import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ancestorChain } from "./terminal-focus.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const TAIL_BYTES = 65536;
// How long a subagent transcript can sit unwritten before the agent is assumed
// gone. An agent that was interrupted never writes its `end_turn`, so without
// this its marker would stay on the key forever; it also keeps the tail reads
// below to the handful of files that could still be live.
const SUBAGENT_IDLE_MAX_S = 600;
// How long after a `/compact` command line the session can still be assumed
// to be compacting. Real compactions run 70-120s; the cap is what stops a
// canceled `/compact` (which leaves the command line with nothing after it)
// from spinning forever if the status flip doesn't clear it first.
const COMPACT_MAX_S = 180;

async function readJsonFiles(dir, suffixes = [".json"]) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of names) {
    if (!suffixes.some((s) => name.endsWith(s))) continue;
    try {
      results.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // partial write or corrupt file — skip it, not a crash
    }
  }
  return results;
}

function isUnder(path, folder) {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : folder + "/");
}

/**
 * Matches a session's cwd to the open VS Code window it belongs to. An exact
 * match always wins over an ancestor match — a worktree opened as its own
 * window is a real session, not a nested one. Among ancestor-only matches,
 * the most specific (longest) folder wins, so a session nested several
 * levels deep attaches to its closest open ancestor rather than whichever
 * folder happened to come first in lock-file order.
 */
export function matchFolder(cwd, folders) {
  // isUnder already tolerates a trailing slash on `folder`; strip one from
  // `cwd` too so an incidental trailing slash there can't make an exact
  // match miss and fall through to being misclassified as nested.
  const target = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (folders.includes(target)) return { folder: target, nested: false };
  const ancestors = folders.filter((f) => isUnder(target, f));
  if (ancestors.length === 0) return null;
  const folder = ancestors.reduce((best, f) => (f.length > best.length ? f : best));
  return { folder, nested: true };
}

// Exported for window-state.mjs, which needs the same test on a different kind
// of pid — a VS Code extension host rather than a Claude process. One
// definition rather than two: signal 0 meaning "does this pid exist" is the
// kind of detail that gets re-derived subtly wrong.
export function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code stores a session's transcript under a directory named after its
 * cwd, with every character outside [a-zA-Z0-9] flattened to `-`.
 *
 * It is the full class, not just `/` and `.`: a worktree named `feat+thing`
 * lands in `-…-worktrees-feat-thing`, and encoding only the two obvious
 * characters aimed us at a path that doesn't exist. That failure is silent by
 * design — every read here is try/catch — so those sessions simply lost their
 * title, model tile and blocked/compacting detection with nothing to show for
 * it.
 */
export function transcriptPathFor({ cwd, sessionId }, root = CLAUDE_DIR) {
  return join(projectDirFor(cwd, root), `${sessionId}.jsonl`);
}

function projectDirFor(cwd, root = CLAUDE_DIR) {
  return join(root, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * The last `TAIL_BYTES` of a transcript, split into lines, newest last. These
 * files run to megabytes and everything read from them is near the end.
 * Returns no lines rather than throwing: they're written by another process and
 * a poll can land mid-write, or the file can be gone by the time we open it.
 * The first line is likely a fragment — every caller parses per line and skips
 * what won't parse.
 *
 * `whole` says the window reached byte 0, so absence in `lines` is absence in
 * the file. Every other signal here is found by scanning backwards and stops at
 * the first hit, which the tail can only ever help; "nothing said in this
 * session yet" is the one that needs to know it saw everything. A read that
 * failed reports `false` — unknown, not empty.
 */
export async function tailLines(path) {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read({ buffer, position: start });
    return { lines: buffer.subarray(0, bytesRead).toString("utf8").split("\n"), whole: start === 0 };
  } catch {
    return { lines: [], whole: false };
  } finally {
    await fh?.close();
  }
}

// /clear writes a plain command line into the same transcript rather than
// starting a new file, so a naive backward scan for aiTitle would keep
// surfacing the pre-clear summary as if the fresh context were still about
// that. This is the literal tag Claude Code writes for it.
const CLEAR_MARKER = "<command-name>/clear</command-name>";

// A denied-by-auto-mode tool result comes back as an ordinary `type:"user"`
// line (it's a tool_result, so it's on the user turn) carrying this field.
// Every transcript line's own top-level `type` is written before any nested
// `message.type`, so this substring reliably means *this* line, not some
// tool_use/tool_result payload mentioning "user" inside its content.
const USER_LINE_MARKER = '"type":"user"';

/**
 * Two things read from the same tail scan of a session's transcript, since
 * reading the whole file to find either doesn't scale:
 *
 * `aiTitle` — Claude Code writes this field (an AI-generated summary, the
 * same string VS Code's terminal list shows) onto transcript lines repeatedly
 * as a session progresses; this is the most recent one. `clearedEmpty` is
 * true when a `/clear` was crossed before any aiTitle was found scanning
 * backwards: nothing has happened in the session since, as far as this tail
 * window can see, so a title from before it would describe a conversation
 * that's gone.
 *
 * `startedEmpty` — the same "nothing to say yet", reached the other way: a
 * session opened and not yet typed into. Claude Code writes a transcript the
 * moment the session starts (a mode line, a snapshot, any SessionStart hook
 * output, all `type:"attachment"`), so the file existing says nothing; the
 * first `type:"user"` line is the human's first prompt. Requires `whole`,
 * because "no user line in the tail" is otherwise just as true of a session
 * whose last 64KB happen to be one long tool-calling stretch.
 *
 * `blockedOnDenial` — true when the most recent `type:"user"` line (newest
 * first) is a tool-call denied by the auto-mode classifier, with nothing from
 * the human since. Claude Code's own session status goes "idle" once that
 * turn ends, identical to any other turn that ended cleanly — this is the one
 * way we can tell that idle actually means "asked you for permission and is
 * waiting," not "waiting for whatever's next." It's a narrow signal, not
 * proof: an assistant that recovers and keeps working without another human
 * line in between would also match, until it either says something (ending
 * the turn, but by then it's usually done exactly what this flags) or you
 * reply. Good enough for a key that just needs your attention, not a promise.
 */
export async function readTranscriptSignals(transcriptPath, tail = tailLines) {
  try {
    const { lines, whole } = await tail(transcriptPath);

    let aiTitle = null,
      clearedEmpty = false,
      titleResolved = false;
    let blockedOnDenial = false,
      denialResolved = false;
    let model = null,
      effort = null,
      modelResolved = false;

    // `compactRequestedAt` — the timestamp of the newest `type:"user"` line
    // when that line is a `/compact` command with nothing from the
    // conversation after it. Running `/compact` writes its command line
    // immediately, then the transcript goes quiet until the boundary — so
    // this is a direct start marker, not an inference. When compaction
    // finishes (or is canceled and the conversation resumes), a newer user
    // line exists and the signal clears itself. An earlier version inferred
    // compaction from transcript *silence* instead; a turn thinking for 25s+
    // writes nothing either, so busy sessions kept false-firing.
    let compactRequestedAt = null;

    for (let i = lines.length - 1; i >= 0 && (!titleResolved || !denialResolved || !modelResolved); i--) {
      const line = lines[i];
      // Every marker below is a substring *pre-filter* only — cheap enough to
      // run down a megabyte of tail — and nothing is believed until this
      // line's own JSON says so. A transcript carries tool results verbatim,
      // so any of these strings can appear inside content that is not the
      // thing it marks: a session that greps this very file, or prints
      // another transcript, writes `<command-name>/clear</command-name>`,
      // `toolDenialKind` and `"type":"user"` into its own tail as *text*.
      // That's not hypothetical — it blanked this project's own key.
      // Parsed once, lazily, and shared by all three branches.
      let obj;
      let parsed = false;
      const parse = () => {
        if (!parsed) {
          parsed = true;
          try {
            obj = JSON.parse(line);
          } catch {
            obj = null; // truncated line at the start of the tail slice
          }
        }
        return obj;
      };
      // A line's own top-level type, never a substring: `"type":"user"` inside
      // a tool result would otherwise end the newest-user-line scan on a line
      // that isn't one.
      const typeIs = (t) => parse()?.type === t;
      // Slash commands are written as an ordinary user line whose content
      // *starts* with the command tag (both formats Claude Code writes).
      // Content that merely contains one is a quote of it.
      const isCommand = (name) => {
        const content = parse()?.message?.content;
        return (
          content === name ||
          (typeof content === "string" && content.startsWith(`<command-name>${name}</command-name>`))
        );
      };

      if (!titleResolved) {
        if (line.includes("aiTitle")) {
          const o = parse();
          if (typeof o?.aiTitle === "string" && o.aiTitle) {
            aiTitle = o.aiTitle;
            titleResolved = true;
          }
        }
        if (!titleResolved && line.includes(CLEAR_MARKER) && typeIs("user") && isCommand("/clear")) {
          clearedEmpty = true;
          titleResolved = true;
        }
      }

      if (!denialResolved && line.includes(USER_LINE_MARKER) && typeIs("user")) {
        // A top-level field of this line, not a string somewhere in it.
        blockedOnDenial = parse().toolDenialKind !== undefined;
        // The same newest-user-line decides compacting: /compact writes its
        // command line immediately and then goes quiet, so the line is the
        // start marker.
        if (isCommand("/compact")) {
          const t = Date.parse(parse().timestamp);
          if (Number.isFinite(t)) compactRequestedAt = t;
        }
        denialResolved = true;
      }

      // Model and effort ride on assistant lines; the newest one is what the
      // session is running right now. Same scan, no extra read.
      if (!modelResolved && line.includes('"type":"assistant"') && typeIs("assistant")) {
        const o = parse();
        // Claude Code writes its own interrupt and API-error entries as
        // assistant lines claiming `model: "<synthetic>"`. Those are the
        // moments you're most likely to be looking at the deck, and the tile
        // would read "<synthetic>" — keep scanning back for a real turn.
        if (o.message?.model && o.message.model !== "<synthetic>") {
          model = o.message.model;
          effort = o.effort ?? null;
          modelResolved = true;
        }
      }
    }

    // `denialResolved` is set exactly when the scan met a `type:"user"` line,
    // so it doubles as "the human has said something". The aiTitle and
    // clearedEmpty guards are belt-and-braces — neither can exist without a
    // user line ahead of it — so this can only ever blank a key that has
    // nothing else to draw.
    const startedEmpty = whole && !denialResolved && !aiTitle && !clearedEmpty;

    return { aiTitle, clearedEmpty, startedEmpty, blockedOnDenial, model, effort, compactRequestedAt };
  } catch {
    return {
      aiTitle: null,
      clearedEmpty: false,
      startedEmpty: false,
      blockedOnDenial: false,
      model: null,
      effort: null,
      compactRequestedAt: null,
    };
  }
}

/**
 * The subagents a session has running right now.
 *
 * An Agent-tool subagent — the thing behind "Waiting for 1 background agent to
 * finish" — never registers in ~/.claude/sessions: it runs inside its parent's
 * process, and exists on disk only as a transcript under the parent's own
 * `<session id>/subagents/` directory. So the entrypoint rule in
 * `getLiveSessions` can't see it; that one only finds *SDK* sessions, which
 * are separate processes with registry entries of their own.
 *
 * Running is read from the newest `stop_reason` in that transcript, which is
 * an exact marker rather than a guess: an agent waiting on a tool last stopped
 * for "tool_use", and one that has handed its result back ends "end_turn" and
 * writes nothing further. A just-spawned agent has no stop_reason yet and
 * counts as running — its mtime is seconds old, and `SUBAGENT_IDLE_MAX_S` is
 * what retires the other no-ending case, an agent interrupted mid-tool.
 *
 * Takes the directory rather than a session so the check can point it at a
 * fixture. Every read is try/catch-skipped, same as everything else here.
 */
export async function readRunningSubagents(dir, tail = tailLines) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return []; // no subagents dir — this session has never spawned one
  }

  const running = [];
  for (const name of names) {
    const path = join(dir, name);
    let mtimeMs;
    try {
      ({ mtimeMs } = await stat(path));
    } catch {
      continue; // vanished between readdir and stat
    }
    if ((Date.now() - mtimeMs) / 1000 > SUBAGENT_IDLE_MAX_S) continue;

    // A source-supplied tail (ssh-backed) can reject mid-poll; every other
    // read here is try/catch-skipped and this one has to be too, or one bad
    // read takes the whole board down through sessionsFrom's Promise.all.
    const { lines } = await tail(path).catch(() => ({ lines: [] }));
    let stopReason = null;
    for (let i = lines.length - 1; i >= 0 && stopReason === null; i--) {
      // Parse before trusting: "stop_reason" appears inside tool results and
      // prose all the time, which is exactly the trap the /compact marker fell
      // into. Only this line's own message counts.
      if (!lines[i].includes("stop_reason")) continue;
      try {
        stopReason = JSON.parse(lines[i]).message?.stop_reason ?? null;
      } catch {
        // truncated line at the start of the tail slice — keep scanning
      }
    }
    if (stopReason === "end_turn") continue;

    let description = null;
    try {
      ({ description = null } = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8")));
    } catch {
      // no meta yet, or mid-write — the tile falls back to the agent id
    }
    running.push({ id: name.replace(/^agent-|\.jsonl$/g, ""), description, ts: Math.floor(mtimeMs / 1000) });
  }
  return running;
}

/**
 * Works out "task X of Y" for a list of tasks.
 *
 * Two numbering schemes, because a list's own numbering can disagree with its
 * length: a plan whose items are named "Task 4..Task 10" is eight files long,
 * so its in-progress item sits at position 3 while everyone involved calls it
 * task 6. When the subjects carry explicit numbers those win; otherwise the
 * position in the list is used.
 *
 * X is the in-progress task, or the furthest-along completed one when nothing
 * is running, so the pair stays on one scheme instead of flipping.
 */
export function taskCounter(tasks) {
  const numbers = tasks.map((t) => {
    const match = /^\s*task\s+(\d+)/i.exec(t.subject ?? "");
    return match ? Number(match[1]) : null;
  });
  const numbered = numbers.filter((n) => n !== null);
  const useSubjects = numbered.length >= Math.ceil(tasks.length / 2);
  const numberAt = (i) => (useSubjects && numbers[i] !== null ? numbers[i] : i + 1);

  const active = tasks.findIndex((t) => t.status === "in_progress");
  const doneIndexes = tasks.map((t, i) => (t.status === "completed" ? i : -1)).filter((i) => i >= 0);

  const current =
    active >= 0 ? numberAt(active) : doneIndexes.length ? Math.max(...doneIndexes.map(numberAt)) : 0;
  const total = useSubjects ? Math.max(...numbered) : tasks.length;

  return { current, total: Math.max(current, total) };
}

/**
 * Every task for a session, in creation order. Task files are named by
 * numeric id, so they're sorted numerically — "10" after "2", not before it.
 * Returns [] for a session that isn't using tasks, and skips any file caught
 * mid-write rather than throwing.
 */
export async function readTaskList(sessionId, root = CLAUDE_DIR) {
  const dir = join(root, "tasks", sessionId);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const tasks = [];
  for (const name of names) {
    try {
      tasks.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // mid-write — skip
    }
  }
  return tasks;
}

/**
 * Task progress for a session, from the per-task JSON files Claude Code keeps
 * in ~/.claude/tasks/<session id>/. Returns null when a session isn't using
 * tasks at all, so the button can stay clean rather than showing "0/0".
 */
async function readTaskProgress(sessionId, root) {
  const tasks = await readTaskList(sessionId, root);
  if (tasks.length === 0) return null;
  return { ...taskCounter(tasks), active: tasks.find((t) => t.status === "in_progress")?.subject ?? null };
}

/**
 * The `size` tasks worth showing. Centred on the in-progress one so you see
 * what's just been done and what's next, clamped at both ends so the window
 * is always full when the list is long enough to fill it. No in-progress task
 * (a finished or not-yet-started list) starts at the top.
 */
export function taskWindow(tasks, size) {
  if (tasks.length <= size) return tasks;
  const active = tasks.findIndex((t) => t.status === "in_progress");
  if (active < 0) return tasks.slice(0, size);
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), tasks.length - size));
  return tasks.slice(start, start + size);
}

/**
 * Context usage for a session, as a percentage of that model's window.
 *
 * Claude Code keeps this number to itself — it isn't in the registry or the
 * transcript — but it hands it to the status line on every render, so
 * ~/.claude/statusline-command.sh drops it here for us. Returns null when the
 * status line hasn't written for this session (or isn't installed), which
 * simply leaves the gauge off that key.
 *
 * A stale file is fine: context can't change while a session sits idle, and an
 * active session rewrites this on every render.
 */
async function readContext(sessionId, root = CLAUDE_DIR) {
  try {
    const { context } = JSON.parse(await readFile(join(root, "ctx", `${sessionId}.json`), "utf8"));
    return typeof context === "number" ? context : null;
  } catch {
    return null;
  }
}

/**
 * The local machine as a source: today's behaviour, named.
 *
 * A source is the whole host-dependent surface of this module — where the tree
 * is, whether a pid is alive, and how a transcript tail is read. Every path here
 * derives from one root, so those three are all a remote host needs to supply;
 * everything between them is this file, unchanged, which is the point. See
 * docs/superpowers/specs/2026-08-16-remote-ssh-sessions-design.md.
 */
export function localSource(root = CLAUDE_DIR) {
  return { host: null, root, isAlive, tail: tailLines };
}

/**
 * Maps `sessionsFrom` over every source and flattens the result — the whole of
 * what a remote host adds at this level. A source's `isAlive`/`tail` are
 * someone else's code (ssh-backed, for a remote host), which can throw where a
 * local read would merely fail try/catch, so each call is isolated with its
 * own `.catch(() => [])`: one bad host drops only its own keys, the way a
 * closed window's would, rather than taking the whole board's Promise.all
 * down with it.
 */
export async function getLiveSessions(sources = [localSource()]) {
  return (await Promise.all(sources.map((s) => sessionsFrom(s).catch(() => [])))).flat();
}

/**
 * Live sessions for one source: interactive, still running by that source's
 * own `isAlive`, and working in a folder some open VS Code window has in its
 * workspace.
 *
 * State comes from the registry's own `status` field rather than being
 * inferred from hooks — it distinguishes "waiting" and "requires_action"
 * (blocked on you) from plain "busy", which guessing from hook events can't.
 * One narrow exception: an "idle" session whose last turn ended right after
 * an auto-mode permission denial is promoted to "requires_action" too — see
 * `readTranscriptSignals`'s `blockedOnDenial`. The registry reports that
 * exact case as a plain completed turn, same as any other idle session, so
 * without this a session that just asked you for a permission rule reads on
 * the deck as no different from one that's simply caught up.
 *
 * Two kinds of thing come back flagged `nested: true`, which index.mjs keeps
 * off the board's own slots: an SDK session (a separate process with its own
 * registry entry, told apart by `entrypoint`), and a running Agent-tool
 * subagent, which has no registry entry at all and is read off disk by
 * `readRunningSubagents`.
 */
async function sessionsFrom(source) {
  const [registry, locks] = await Promise.all([
    readJsonFiles(join(source.root, "sessions")),
    readJsonFiles(join(source.root, "ide"), [".lock"]),
  ]);

  // Locks aren't only VS Code's — JetBrains IDEs write the same file with
  // their own `ideName`. Keep that per folder so a press focuses the IDE the
  // session actually lives in. Two IDEs on one folder: last lock wins.
  const ideByFolder = new Map();
  for (const l of locks) {
    for (const f of l.workspaceFolders ?? []) ideByFolder.set(f, l.ideName ?? null);
  }
  const folders = [...ideByFolder.keys()];

  const matched = [];
  for (const s of registry) {
    if (s.kind !== "interactive" || !s.sessionId || !s.cwd || !s.pid) continue;
    // Nested = spawned by another session, and `entrypoint` is what says so.
    // A headless SDK run (a security review, a scripted agent) registers
    // itself as `kind: "interactive"` with the repo as its cwd, so `kind`
    // can't tell it from a session you opened — but its entrypoint is
    // "sdk-py"/"sdk-ts" where a session you started yourself is "cli".
    //
    // This used to be inferred from the cwd instead: anything below the
    // window's folder was called nested. That caught SDK helpers, and it also
    // caught every worktree — which is where most real work happens, so it
    // hid full agents behind a marker meant for background helpers. The
    // entrypoint says what the cwd only guessed at.
    //
    // Matching the sdk prefix rather than allowlisting "cli", so an entrypoint
    // we haven't seen yet gets a key rather than disappearing.
    const isNested = s.entrypoint?.startsWith("sdk") ?? false;
    if (!source.isAlive(s.pid)) continue;
    const match = matchFolder(s.cwd, folders);
    if (!match) continue; // no live local VS Code window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder: match.folder,
      // Claude's own pid, kept for terminal-focus.mjs: the VS Code terminal
      // running this session is the one whose shell is an ancestor of it.
      // Already read just above for the liveness check.
      pid: s.pid,
      ide: ideByFolder.get(match.folder) ?? null,
      nested: isNested,
      name: s.name ?? null,
      state: s.status ?? "idle",
      ts: Math.floor((s.statusUpdatedAt ?? s.updatedAt ?? 0) / 1000),
      host: source.host,
      root: source.root,
      // Only a remote session carries its chain, and only because it cannot be
      // walked later: `requestFocus` runs inside a synchronous key handler, and
      // this host's pids mean something else entirely on the local machine. A
      // local session deliberately gets none — its table is read live at press
      // time, which is both correct and current.
      //
      // `undefined` rather than an empty array when the host gave no ppid
      // table: "no ancestry available" and "an ancestry with nothing in it" are
      // the same outcome for the reveal, but only the first reads as a fact
      // about the host rather than about the session.
      ...(source.ppids?.size ? { ancestors: ancestorChain(s.pid, source.ppids) } : {}),
    });
  }

  // Subagents have no registry entry of their own, so they're synthesised
  // here: nested, in their parent's folder, and busy — a running agent is by
  // definition working. They carry no aiTitle/context/progress (none of that
  // is written for them), so the transcript enrichment below is skipped and
  // the Agent call's own description is what the tile reads.
  //
  // `parent` is the session that spawned it, kept because `session_id` is
  // overwritten with the agent's own id just below. It's what lets index.mjs
  // put the marker on the key of the session actually running the agent: a
  // project with three sessions open in one folder would otherwise paint
  // whichever key happens to come first in the block, and an idle session
  // sitting green for a sibling's agent is a lie the deck can't be read past.
  // An SDK session has no such key to land on and carries no `parent`.
  const subagents = (
    await Promise.all(
      matched.map(async (s) =>
        (
          await readRunningSubagents(join(projectDirFor(s.cwd, source.root), s.session_id, "subagents"), source.tail)
        ).map((a) => ({
          ...s,
          session_id: a.id,
          parent: s.session_id,
          nested: true,
          name: a.description,
          state: "busy",
          ts: a.ts,
        }))
      )
    )
  ).flat();

  const enriched = await Promise.all(
    matched.map(async (s) => {
      const { blockedOnDenial, compactRequestedAt, ...signals } = await readTranscriptSignals(
        transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id }, source.root),
        source.tail
      );
      // A manual /compact writes its command line the moment it starts, then
      // nothing until the finished boundary — so "newest user line is
      // /compact" IS the compaction, observed directly. Requiring busy is
      // what clears the spinner the instant a /compact is canceled (the
      // registry flips back to idle before any new transcript line lands),
      // and the age cap catches the stale-line leftovers busy can't.
      // Auto-triggered compactions write no start marker at all and are
      // deliberately not detected — an earlier silence heuristic tried, and
      // false-fired on every turn that thought for 25s without a tool call.
      const compacting =
        s.state === "busy" && compactRequestedAt !== null && (Date.now() - compactRequestedAt) / 1000 < COMPACT_MAX_S;
      return {
        ...s,
        ...signals,
        state: compacting ? "compacting" : s.state === "idle" && blockedOnDenial ? "requires_action" : s.state,
        progress: await readTaskProgress(s.session_id, source.root),
        context: await readContext(s.session_id, source.root),
      };
    })
  );

  return [...enriched, ...subagents];
}
