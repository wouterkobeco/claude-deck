// Verifies project grouping: sessions for one VS Code window sit in one
// contiguous block, project order and within-project order are both pinned to
// first-seen, and nothing re-sorts by activity.
// Run: node scripts/slots-check.mjs
import { assignSlots } from "../src/index.mjs";

const s = (id, folder) => ({ session_id: id, folder });
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

import { matchFolder } from "../src/sessions.mjs";

// matchFolder: an exact match beats being nested under another open folder —
// a worktree opened as its own VS Code window is a real session, not nested.
eq(matchFolder("/proj/sub", ["/proj", "/proj/sub"]), { folder: "/proj/sub", nested: false }, "exact match wins");

// Among ancestor-only matches, the most specific (longest) folder wins —
// fixes the old .find()'s arbitrary first-match behavior.
eq(
  matchFolder("/proj/sub/deep", ["/proj", "/proj/sub"]),
  { folder: "/proj/sub", nested: true },
  "most specific ancestor wins"
);

// No open folder contains this cwd at all.
eq(matchFolder("/elsewhere", ["/proj"]), null, "no match");

// A trailing slash on cwd (never seen from Claude Code's own registry, but
// cheap to guard) must still resolve as an exact match, not fall through to
// a spurious "nested under itself" ancestor match.
eq(matchFolder("/proj/", ["/proj"]), { folder: "/proj", nested: false }, "trailing slash still matches exactly");

const A = "/projects/alpha";
const B = "/projects/beta";
const slots = new Array(5).fill(null);

assignSlots([s("a1", A), s("b1", B), s("a2", A)], slots);
eq(slots, ["a1", "a2", "b1", null, null], "groups by project, not arrival");

// Input order must not matter — only first-seen order does.
assignSlots([s("b1", B), s("a2", A), s("a1", A)], slots);
eq(slots, ["a1", "a2", "b1", null, null], "stable under reorder");

// A new session joins its own project's block rather than the board's end,
// pushing later projects along.
assignSlots([s("a1", A), s("a2", A), s("a3", A), s("b1", B)], slots);
eq(slots, ["a1", "a2", "a3", "b1", null], "new session joins its project block");

// A whole project going away closes its gap.
assignSlots([s("b1", B)], slots);
eq(slots, ["b1", null, null, null, null], "empty project leaves no gap");

// ...and returning reclaims its original position ahead of beta, because
// folder order is remembered.
assignSlots([s("b1", B), s("a9", A)], slots);
eq(slots, ["a9", "b1", null, null, null], "returning project keeps its place");

// Board full: extras simply get no button.
const small = new Array(2).fill(null);
assignSlots([s("a1", A), s("a2", A), s("b1", B)], small);
eq(small, ["a1", "a2"], "full board drops extras");

console.log("OK: project grouping");
