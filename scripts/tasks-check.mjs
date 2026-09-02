// Verifies "task X of Y": subject numbering wins over list position when
// present, position is used otherwise, and the pair never mixes schemes.
// Run: node scripts/tasks-check.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskCounter, taskWindow } from "../src/sessions.mjs";
import { ledgerTasks, readLedgerTasks } from "../src/sdd-ledger.mjs";

const t = (subject, status = "pending") => ({ subject, status });
const eq = (got, want, label) => {
  const a = `${got.current}/${got.total}`;
  if (a !== want) {
    console.error(`FAILED (${label}): got ${a}, want ${want}`);
    process.exit(1);
  }
};

// The real case: a plan named Task 4..Task 10 plus an unnumbered final item.
// Position would say 3/8; the numbering everyone actually uses says 6/10.
const realPlan = [
  t("Task 4: Grid label", "completed"),
  t("Task 5: Migration 0116", "completed"),
  t("Task 6: Extract RoundsEditor", "in_progress"),
  t("Task 7: Option and unit editors"),
  t("Task 8: EditPanel — two tabs"),
  t("Task 9: SchemeCard + RoundsModal"),
  t("Task 10: Preset picker scoping"),
  t("Final whole-branch review"),
];
eq(taskCounter(realPlan), "6/10", "subject numbering beats position");

// Unnumbered subjects fall back to position in the list.
eq(
  taskCounter([t("Migrate schema", "completed"), t("Add tests", "in_progress"), t("Ship it")]),
  "2/3",
  "positional fallback"
);

// Nothing in progress: report the furthest completed task, same scheme.
eq(
  taskCounter([t("Task 4: a", "completed"), t("Task 5: b", "completed"), t("Task 6: c")]),
  "5/6",
  "furthest completed when idle"
);

// Nothing started at all.
eq(taskCounter([t("Task 1: a"), t("Task 2: b")]), "0/2", "nothing started");

// A stray numbered subject among unnumbered ones must not flip the scheme.
eq(
  taskCounter([t("Investigate"), t("Task 9: odd one out"), t("Wrap up", "in_progress")]),
  "3/3",
  "minority numbering ignored");

// Total never reads lower than the current task.
eq(taskCounter([t("Task 42: late", "in_progress")]), "42/42", "total not below current");

const same = (got, want, label) => {
  const a = JSON.stringify(got.map((t) => t.subject));
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const list = (n) => Array.from({ length: n }, (_, i) => t(`Task ${i + 1}`));
const withActive = (n, activeIndex) => {
  const l = list(n);
  l[activeIndex].status = "in_progress";
  return l;
};

// Fewer tasks than keys: everything shows, untouched.
same(taskWindow(list(3), 8), ["Task 1", "Task 2", "Task 3"], "short list is unchanged");

// The active task sits mid-window when there's room on both sides.
same(
  taskWindow(withActive(20, 9), 5).map((x) => x),
  ["Task 8", "Task 9", "Task 10", "Task 11", "Task 12"],
  "window centres on the in-progress task"
);

// Near the start there's nothing to the left to show — the window must still
// be full, not half-empty.
same(taskWindow(withActive(20, 0), 5), ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"], "clamped at the start");

// Same at the end.
same(
  taskWindow(withActive(20, 19), 5),
  ["Task 16", "Task 17", "Task 18", "Task 19", "Task 20"],
  "clamped at the end"
);

// Nothing in progress: show the first `size`, rather than an empty window.
same(taskWindow(list(20), 3), ["Task 1", "Task 2", "Task 3"], "no active task starts at the top");

same(taskWindow([], 5), [], "empty list");

// A session driving superpowers' SDD keeps its tasks in a ledger in the
// project rather than in ~/.claude/tasks, so the progress bar and the detail
// board saw nothing through a day of six-task work. The two things read are
// the ones the skill itself depends on: the workspace path and the
// `Task <N>: complete` line it resumes from.
const LEDGER = `# SDD ledger — plan: docs/superpowers/plans/2026-08-18-open-ended-goals.md

## Pre-flight conflict scan

| A | B | Shared | Finding |
|---|---|--------|---------|
| 1 | 2 | src/db/values.ts | clean |

Before dispatching Task 1, scan the plan once for conflicts.

## Progress

Task 1: complete (implementer aab72b71). Commit 6afca52b.
Task 2: dispatched (implementer bbc11d22, sonnet).
`;

const briefs = new Map([
  [1, "Task 1: Schema, migration and seed"],
  [2, "Task 2: Carry the goal to every reader"],
  [3, "Task 3: Wording"],
]);

const statuses = ledgerTasks(LEDGER, briefs);
assert.deepEqual(
  statuses.map((t) => t.status),
  ["completed", "in_progress", "pending"],
  "the first task without a complete line is the one in flight"
);
same(statuses, [...briefs.values()], "subjects come from the brief filenames");
eq(taskCounter(statuses), "2/3", "and the counter reads it like any other task list");

// Neither the conflict table's `| 1 | 2 |` rows nor "Before dispatching Task 1"
// mid-sentence is a status line, so neither may invent or finish a task.
assert.equal(ledgerTasks(LEDGER, new Map()).length, 2, "only line-anchored Task <N>: lines count");

// Anything without the identity line the skill mandates is some other
// progress.md, and none of these rules apply to it.
assert.deepEqual(ledgerTasks("# Sprint progress\n\nTask 1: complete\n", briefs), [], "not an SDD ledger");
assert.deepEqual(ledgerTasks("# SDD ledger — plan: x.md\n\nnothing yet\n"), [], "a ledger with no tasks yet");

// Through the real filesystem, since every failure path in the reader returns
// [] and a walk that silently found nothing would look exactly like a session
// that isn't using one.
{
  const root = await mkdtemp(join(tmpdir(), "streamdeck-ledger-check-"));
  const workspace = join(root, ".superpowers/sdd/2026-08-18-plan");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "progress.md"), LEDGER);
  for (const [n, subject] of briefs) await writeFile(join(workspace, `task-${n}-brief.md`), `### ${subject}\n\nbody\n`);

  same(await readLedgerTasks(root), [...briefs.values()], "found at the repo root");
  // The workspace sits at the git root and a session's cwd is often below it.
  const deep = join(root, "src/app/admin");
  await mkdir(deep, { recursive: true });
  assert.deepEqual(
    (await readLedgerTasks(deep)).map((t) => t.status),
    ["completed", "in_progress", "pending"],
    "and from a subdirectory"
  );

  assert.deepEqual(await readLedgerTasks(join(root, "..")), [], "not from above it");
  assert.deepEqual(await readLedgerTasks(null), [], "and never for a remote session, whose cwd is another machine's");

  // Candidates, in order: an SDD controller's own cwd finds nothing (the plan
  // is in the worktree, and this only ever walks up), so its running
  // subagent's cwd answers instead. First hit wins; nulls are skipped.
  const outside = await mkdtemp(join(tmpdir(), "streamdeck-ledger-outside-"));
  same(await readLedgerTasks([outside, root]), [...briefs.values()], "the second candidate answers when the first has no plan");
  assert.deepEqual(await readLedgerTasks([outside, null]), [], "and no candidate at all is still no progress");

  // A finished plan deletes its workspace, so a ledger nobody has touched for
  // a day is abandoned — and would otherwise show its last count on a key
  // forever.
  assert.deepEqual(await readLedgerTasks(root, Date.now() + 25 * 60 * 60 * 1000), [], "a stale ledger is not progress");
}

console.log("OK: task counter, sdd ledger");

// Subjects are indexed by task *number*, the same scheme the counter uses, so
// square 9 on the board names "Task 9" and not whatever sat ninth in the list.
{
  const got = taskCounter([t("Task 4: a", "completed"), t("Task 6: b", "in_progress"), t("Task 5: c")]);
  assert.deepEqual(got.subjects[5], "Task 6: b");
  assert.deepEqual(taskCounter([t("first"), t("second")]).subjects, ["first", "second"]);
}
