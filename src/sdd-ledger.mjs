// Tasks a session is working through that Claude Code doesn't know about.
//
// The progress bar and the detail board's task list both come from
// `~/.claude/tasks/<session id>/`, which Claude Code fills only when a session
// uses its own task tool. A session driving superpowers' subagent-driven
// development doesn't: its controller tracks six tasks in a ledger inside the
// *project*, dispatches an implementer subagent per task, and narrates the
// rest. Measured on this machine, that session showed a blank progress bar and
// an empty detail board for a day of work — and every `~/.claude/tasks/<id>/`
// directory here holds nothing but a `.lock` and a `.highwatermark`.
//
// This is the first thing the daemon reads outside `~/.claude` and VS Code's
// storage, which is why it is its own file and why every path returns `[]`
// rather than throwing. It reads, never writes — the read-only invariant is
// about the four files this project *writes*, and none of them are here.
//
// **The format is another tool's, and that is the risk.** What makes it worth
// taking is that the two things read here are load-bearing for the skill
// itself, not incidental formatting: `scripts/sdd-workspace` fixes the
// directory at `<repo root>/.superpowers/sdd/<plan basename>/`, and the ledger
// contract is quoted in its SKILL.md — "tasks with a `Task <N>: complete` line
// are DONE — do not re-dispatch them; resume at the first task without one".
// A controller that loses that line re-runs finished work, so it is about as
// stable as another tool's file gets. Anything less contractual (the prose in
// between, the fix-round lines) is deliberately not parsed.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const WORKSPACE = join(".superpowers", "sdd");

// How far up from a session's cwd to look for the workspace. It sits at the
// git root, and finding that properly means a `git rev-parse` subprocess per
// session per 2s poll — for a directory this is a handful of failed stats.
const MAX_DEPTH = 6;

// A finished plan deletes its own workspace, so anything still here is either
// live or abandoned, and an abandoned one would otherwise show "3 of 6" on a
// key forever. The ledger is appended to at every dispatch and every
// completion, so hours of silence is a task in flight and a day of it is not.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The ledger's tasks, in the shape `~/.claude/tasks` produces — `{ subject,
 * status }`, statuses `completed` / `in_progress` / `pending`. Same shape on
 * purpose: `taskCounter`, `taskWindow`, the progress bar and the detail
 * board's tiles then all work on it unchanged, and there is one task list in
 * this project rather than two.
 *
 * `briefs` maps a task number to its subject, from the `task-<N>-brief.md`
 * filenames. The ledger itself carries no titles — only numbers and what
 * happened to them — so a plan whose briefs have been cleaned up still counts
 * correctly and just reads "Task 3".
 *
 * Pure, because everything below it is a filesystem walk and this is the part
 * that can be wrong.
 */
export function ledgerTasks(progress, briefs = new Map()) {
  // The identity line the skill mandates as the ledger's first line. Without
  // it this is some other progress.md and none of the rules below apply.
  if (!/^#\s*SDD ledger\b/m.test(progress)) return [];

  const complete = new Set();
  const mentioned = new Set();
  // Anchored at the start of a line: the pre-flight conflict table talks about
  // tasks by number in `| 1 | 2 |` rows, and the prose says things like
  // "Before dispatching Task 1" mid-sentence. Neither is a status line.
  for (const [, digits, rest] of progress.matchAll(/^Task\s+(\d+)\s*:\s*(.*)$/gim)) {
    const n = Number(digits);
    mentioned.add(n);
    if (/^complete\b/i.test(rest.trim())) complete.add(n);
  }

  const total = Math.max(0, ...briefs.keys(), ...mentioned);
  if (total === 0) return [];

  // SDD executes strictly in order and resumes "at the first task without a
  // complete line", so the lowest mentioned-but-unfinished task is the one in
  // flight. A task nobody has mentioned yet hasn't started, which is the
  // difference between `in_progress` and `pending` here.
  const active = [...Array(total).keys()]
    .map((i) => i + 1)
    .find((n) => mentioned.has(n) && !complete.has(n));

  return [...Array(total).keys()].map((i) => {
    const n = i + 1;
    return {
      subject: briefs.get(n) ?? `Task ${n}`,
      status: complete.has(n) ? "completed" : n === active ? "in_progress" : "pending",
    };
  });
}

// `### Task 1: Schema, migration and seed` -> `Task 1: Schema, migration and
// seed`. The heading level is stripped and nothing else: taskCounter reads the
// leading "Task <n>" to decide the numbering scheme, so the subject has to
// keep it.
const subjectOf = (head) => head.replace(/^#+\s*/, "").trim();

/**
 * The newest live plan workspace at or above `cwd`, or null.
 *
 * Newest by its ledger's mtime rather than by its dated name: a plan started
 * last week and picked up again today is the one being worked on, and the name
 * is the plan's date, not the work's.
 */
async function findWorkspace(cwd, now) {
  for (let dir = cwd, depth = 0; depth < MAX_DEPTH; depth++, dir = dirname(dir)) {
    let plans = [];
    try {
      plans = await readdir(join(dir, WORKSPACE));
    } catch {
      if (dirname(dir) === dir) break;
      continue;
    }
    let best = null;
    for (const plan of plans) {
      const workspace = join(dir, WORKSPACE, plan);
      try {
        const { mtimeMs } = await stat(join(workspace, "progress.md"));
        if (!best || mtimeMs > best.mtimeMs) best = { workspace, mtimeMs };
      } catch {
        // Not a plan directory, or a ledger caught mid-write.
      }
    }
    if (best) return now - best.mtimeMs < MAX_AGE_MS ? best.workspace : null;
    if (dirname(dir) === dir) break;
  }
  return null;
}

/**
 * The tasks a session's SDD ledger says it is working through, or `[]`.
 *
 * `cwd` is a **local** path, or a list of them tried in order. A remote
 * session's cwd names a directory on the other machine, and `remote-fs.mjs`
 * fetches `~/.claude` and nothing else — so callers pass null for those rather
 * than reading a path that, here, is either missing or somebody else's
 * project. That is the one place this doesn't hold to "the same code either
 * way".
 *
 * The list exists because `findWorkspace` only ever walks *up*: a controller
 * running superpowers' SDD from a repo root has the plan a level down, inside
 * the worktree, and its own cwd finds nothing. Its running subagent's cwd is
 * where that plan is, and `sessions.mjs` passes it second — see the
 * attribution note there for why a subagent's cwd may speak for its parent
 * and a sibling session's may not.
 */
export async function readLedgerTasks(cwd, now = Date.now()) {
  const candidates = (Array.isArray(cwd) ? cwd : [cwd]).filter(Boolean);
  for (const candidate of candidates) {
    const tasks = await ledgerTasksAt(candidate, now);
    if (tasks.length) return tasks;
  }
  return [];
}

async function ledgerTasksAt(cwd, now) {
  try {
    const workspace = await findWorkspace(cwd, now);
    if (!workspace) return [];

    const briefs = new Map();
    for (const name of await readdir(workspace)) {
      const match = /^task-(\d+)-brief\.md$/.exec(name);
      if (!match) continue;
      try {
        const head = (await readFile(join(workspace, name), "utf8")).split("\n", 1)[0];
        briefs.set(Number(match[1]), subjectOf(head));
      } catch {
        // Mid-write, or gone since the readdir. The number is still known.
        briefs.set(Number(match[1]), `Task ${Number(match[1])}`);
      }
    }
    return ledgerTasks(await readFile(join(workspace, "progress.md"), "utf8"), briefs);
  } catch {
    // Same contract as every other reader here: a board that draws either way.
    return [];
  }
}
