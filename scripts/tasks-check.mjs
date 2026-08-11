// Verifies "task X of Y": subject numbering wins over list position when
// present, position is used otherwise, and the pair never mixes schemes.
// Run: node scripts/tasks-check.mjs
import { taskCounter } from "../src/sessions.mjs";

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

console.log("OK: task counter");
