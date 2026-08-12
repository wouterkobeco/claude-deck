// Verifies the transcript tail scan: aiTitle stops at the most recent /clear
// rather than surfacing a summary from a conversation that's already gone,
// and blockedOnDenial flags a turn that ended right after an auto-mode
// permission denial with nothing from the human since.
// Run: node scripts/title-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptSignals } from "../src/sessions.mjs";

const dir = await mkdtemp(join(tmpdir(), "streamdeck-title-check-"));
const path = join(dir, "transcript.jsonl");
const titleLine = (t) => JSON.stringify({ type: "assistant", aiTitle: t });
const clearLine = JSON.stringify({
  type: "user",
  message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" },
});
const denialLine = JSON.stringify({
  type: "user",
  toolDenialKind: "automode-blocked",
  message: { role: "user", content: [{ type: "tool_result", content: "Permission for this action was denied" }] },
});
const assistantLine = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "I'm blocked, here's what I need from you." }] },
});
const humanReplyLine = JSON.stringify({ type: "user", message: { role: "user", content: "ok go ahead" } });

const write = (lines) => writeFile(path, lines.join("\n") + "\n");
const signals = (lines) => write(lines).then(() => readTranscriptSignals(path));

assert.deepEqual(await signals([titleLine("Fix login bug")]), {
  aiTitle: "Fix login bug",
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
});

assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine, titleLine("Add rate limiting")]), {
  aiTitle: "Add rate limiting",
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
});

// An old title must not survive a /clear with nothing said since.
assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine]), {
  aiTitle: null,
  clearedEmpty: true,
  blockedOnDenial: false,
  model: null,
  effort: null,
});

assert.deepEqual(await readTranscriptSignals(join(dir, "missing.jsonl")), {
  aiTitle: null,
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
});
console.log("OK: aiTitle / clearedEmpty");

// The case this exists for: a denial with nothing newer from the human.
assert.equal((await signals([denialLine])).blockedOnDenial, true);
// The assistant's own explanation after the denial doesn't count as a reply.
assert.equal((await signals([denialLine, assistantLine])).blockedOnDenial, true);
// The moment the human replies, the flag clears — even without a new denial.
assert.equal((await signals([denialLine, assistantLine, humanReplyLine])).blockedOnDenial, false);
console.log("OK: blockedOnDenial");

await rm(dir, { recursive: true, force: true });
