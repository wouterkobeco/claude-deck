// Verifies sticky slot assignment: positions never shuffle, ended sessions
// free their spot, and a new session takes the lowest free slot.
// Run: node scripts/slots-check.mjs
import { assignSlots } from "../src/index.mjs";

const s = (id) => ({ session_id: id });
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const slots = new Array(4).fill(null);

assignSlots([s("a"), s("b"), s("c")], slots);
eq(slots, ["a", "b", "c", null], "initial fill");

// Reordered input (e.g. activity changed) must NOT reshuffle the board.
assignSlots([s("c"), s("a"), s("b")], slots);
eq(slots, ["a", "b", "c", null], "stable under reorder");

// A new session appends at the end while all earlier slots are taken.
assignSlots([s("a"), s("b"), s("c"), s("d")], slots);
eq(slots, ["a", "b", "c", "d"], "new session appends");

// An ended session frees exactly its own slot; others stay put.
assignSlots([s("a"), s("c"), s("d")], slots);
eq(slots, ["a", null, "c", "d"], "ended session frees its slot");

// The next new session reuses that liberated spot, not the end.
assignSlots([s("a"), s("c"), s("d"), s("e")], slots);
eq(slots, ["a", "e", "c", "d"], "new session reuses freed slot");

// Board full: an extra session simply gets no button.
assignSlots([s("a"), s("c"), s("d"), s("e"), s("f")], slots);
eq(slots, ["a", "e", "c", "d"], "full board drops extras");

console.log("OK: slot assignment");
