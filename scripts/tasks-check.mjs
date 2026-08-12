// Verifies "task X of Y": subject numbering wins over list position when
// present, position is used otherwise, and the pair never mixes schemes.
// Run: node scripts/tasks-check.mjs
import { taskCounter, taskWindow } from "../src/sessions.mjs";

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

console.log("OK: task counter");
