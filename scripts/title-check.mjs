// Verifies the transcript tail scan: aiTitle stops at the most recent /clear
// rather than surfacing a summary from a conversation that's already gone,
// blockedOnDenial flags a turn that ended right after an auto-mode
// permission denial with nothing from the human since, and model/effort come
// from the newest assistant line. One file for the whole function — two
// files testing one function is what let a field addition ship checked by
// only one of them.
// Run: node scripts/title-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptSignals, transcriptPathFor } from "../src/sessions.mjs";

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
  lastLineAt: null,
  toolPending: false,
});

assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine, titleLine("Add rate limiting")]), {
  aiTitle: "Add rate limiting",
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  lastLineAt: null,
  toolPending: false,
});

// An old title must not survive a /clear with nothing said since.
assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine]), {
  aiTitle: null,
  clearedEmpty: true,
  blockedOnDenial: false,
  model: null,
  effort: null,
  lastLineAt: null,
  toolPending: false,
});

assert.deepEqual(await readTranscriptSignals(join(dir, "missing.jsonl")), {
  aiTitle: null,
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  lastLineAt: null,
  toolPending: false,
});
console.log("OK: aiTitle / clearedEmpty");

// The case this exists for: a denial with nothing newer from the human.
assert.equal((await signals([denialLine])).blockedOnDenial, true);
// The assistant's own explanation after the denial doesn't count as a reply.
assert.equal((await signals([denialLine, assistantLine])).blockedOnDenial, true);
// The moment the human replies, the flag clears — even without a new denial.
assert.equal((await signals([denialLine, assistantLine, humanReplyLine])).blockedOnDenial, false);
console.log("OK: blockedOnDenial");

// Model and effort ride on assistant lines; the newest one is what the
// session is running right now. Same scan, no extra read.
const modelLine = (model, effort) => JSON.stringify({ type: "assistant", effort, message: { model } });
const userTurnLine = JSON.stringify({ type: "user", message: { content: [] } });

assert.deepEqual(await signals([modelLine("claude-sonnet-5", "low"), userTurnLine, modelLine("claude-opus-5", "high")]), {
  aiTitle: null,
  clearedEmpty: false,
  blockedOnDenial: false,
  model: "claude-opus-5",
  effort: "high",
  lastLineAt: null,
  toolPending: false,
});

// A transcript with no assistant line yet reports null rather than guessing.
assert.deepEqual(await signals([userTurnLine]), {
  aiTitle: null,
  clearedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  lastLineAt: null,
  toolPending: false,
});
// The two signals compaction detection rests on. `toolPending` is the one
// that matters: a long-running command is silent too, so without it a
// five-minute test run would read as a compaction.
const toolUseLine = (ts) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: "Bash" }] } });
const toolResultLine = (ts) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result" }] } });

const running = await signals([toolResultLine("2026-08-12T10:00:00.000Z"), toolUseLine("2026-08-12T10:00:05.000Z")]);
assert.equal(running.toolPending, true, "newest tool line is an unanswered tool_use — a tool is running");
assert.equal(running.lastLineAt, Date.parse("2026-08-12T10:00:05.000Z"), "lastLineAt is the newest timestamp");

const settled = await signals([toolUseLine("2026-08-12T10:00:00.000Z"), toolResultLine("2026-08-12T10:00:09.000Z")]);
assert.equal(settled.toolPending, false, "newest tool line is the result — nothing outstanding");

// A transcript with no tool lines at all must not claim one is pending.
assert.equal((await signals([userTurnLine])).toolPending, false, "no tool lines means nothing pending");
console.log("OK: compaction silence signals");

console.log("OK: model / effort");

// The directory name Claude Code derives from a cwd flattens *every*
// non-alphanumeric, not just `/` and `.`. Worktrees named `feat+thing` are the
// case that caught this: aiming at the wrong directory fails silently, so the
// only symptom was a key with no title and no model.
assert.equal(
  transcriptPathFor({ cwd: "/Users/x/p/.claude/worktrees/feat+thing", sessionId: "abc" }),
  join(homedir(), ".claude/projects/-Users-x-p--claude-worktrees-feat-thing/abc.jsonl"),
  "+ and _ flatten to - like every other non-alphanumeric"
);
assert.equal(
  transcriptPathFor({ cwd: "/Users/x/my_proj.v2", sessionId: "abc" }),
  join(homedir(), ".claude/projects/-Users-x-my-proj-v2/abc.jsonl")
);
console.log("OK: transcript path encoding");

// Claude Code's own interrupt/error entries are assistant lines claiming
// `<synthetic>`. The scan looks past them for the last real turn.
const synthetic = JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } });
const afterInterrupt = await signals([
  JSON.stringify({ type: "assistant", effort: "high", message: { model: "claude-opus-5" } }),
  synthetic,
]);
assert.equal(afterInterrupt.model, "claude-opus-5", "<synthetic> is not a model");
assert.equal(afterInterrupt.effort, "high");
assert.equal((await signals([synthetic])).model, null, "nothing but synthetic reports no model");
console.log("OK: synthetic model lines skipped");

await rm(dir, { recursive: true, force: true });
