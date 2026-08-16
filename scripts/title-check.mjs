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
  startedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  compactRequestedAt: null,
});

assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine, titleLine("Add rate limiting")]), {
  aiTitle: "Add rate limiting",
  clearedEmpty: false,
  startedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  compactRequestedAt: null,
});

// An old title must not survive a /clear with nothing said since.
assert.deepEqual(await signals([titleLine("Fix login bug"), clearLine]), {
  aiTitle: null,
  clearedEmpty: true,
  startedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  compactRequestedAt: null,
});

assert.deepEqual(await readTranscriptSignals(join(dir, "missing.jsonl")), {
  aiTitle: null,
  clearedEmpty: false,
  startedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  compactRequestedAt: null,
});
// A session that's open but has never been typed into. Claude Code writes
// these three the moment it starts — a mode line, a file-history snapshot and
// any SessionStart hook output, all of which are `type:"attachment"`, not
// user lines — so the file existing proves nothing about whether anything has
// happened in it. Same blank body as a /clear.
const modeLine = JSON.stringify({ type: "mode", mode: "normal" });
const snapshotLine = JSON.stringify({ type: "file-history-snapshot", snapshot: { trackedFileBackups: {} } });
const hookLine = JSON.stringify({ type: "attachment", attachment: { hookEvent: "SessionStart", content: "hi" } });
assert.equal((await signals([modeLine, snapshotLine, hookLine])).startedEmpty, true, "opened, nothing typed yet");
// The human's first prompt ends it, even before any assistant reply or title.
assert.equal((await signals([modeLine, hookLine, humanReplyLine])).startedEmpty, false, "one prompt is interaction");

// The guard that keeps this from misfiring on a long session: a tail that
// didn't reach byte 0 can't prove absence. 64KB of assistant lines with the
// human's prompt pushed off the top would otherwise blank a working key.
const filler = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x".repeat(200) } });
assert.equal((await signals(Array(400).fill(filler))).startedEmpty, false, "a truncated tail proves nothing");

// A transcript quoting its own markers. Tool results are stored verbatim, so a
// session that greps this repo or prints another transcript writes
// `<command-name>/clear</command-name>`, `toolDenialKind` and `"type":"user"`
// into its own tail as *text* — and every one of those is a `type:"user"`
// line, because a tool result rides on the user turn. This is not a
// hypothetical: it blanked this project's own key and painted it as blocked,
// which is how the raw-substring matching got found.
const quotingLine = (text) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: text }] },
  });
const quoted = await signals([
  titleLine("Fix login bug"),
  quotingLine(`grep output: CLEAR_MARKER = "<command-name>/clear</command-name>"`),
  quotingLine(`transcript dump: {"type":"user","toolDenialKind":"automode-blocked"}`),
]);
assert.equal(quoted.aiTitle, "Fix login bug", "a quoted /clear is not a /clear");
assert.equal(quoted.clearedEmpty, false, "a quoted /clear is not a /clear");
assert.equal(quoted.blockedOnDenial, false, "a quoted denial field is not a denial");
// The same rule on the command that already had it, now sharing the code path.
assert.equal((await signals([quotingLine("<command-name>/compact</command-name>")])).compactRequestedAt, null);

console.log("OK: aiTitle / clearedEmpty / startedEmpty");

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
  startedEmpty: false,
  blockedOnDenial: false,
  model: "claude-opus-5",
  effort: "high",
  compactRequestedAt: null,
});

// A transcript with no assistant line yet reports null rather than guessing.
assert.deepEqual(await signals([userTurnLine]), {
  aiTitle: null,
  clearedEmpty: false,
  startedEmpty: false,
  blockedOnDenial: false,
  model: null,
  effort: null,
  compactRequestedAt: null,
});
// Compaction start marker: a manual /compact writes its command line the
// moment it starts, then nothing until the boundary — so "newest user line
// is /compact" is the signal. Both content formats Claude Code writes, and
// it must match the parsed content exactly: transcripts are full of lines
// that merely *contain* the string "/compact" (tool results, prose).
const TS = "2026-08-12T21:06:21.793Z";
const compactBare = JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content: "/compact" } });
const compactXml = JSON.stringify({
  type: "user",
  timestamp: TS,
  message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" },
});
const mentionLine = JSON.stringify({
  type: "user",
  timestamp: "2026-08-12T21:08:00.000Z",
  message: { role: "user", content: [{ type: "tool_result", content: "grep found /compact in 3 files" }] },
});

assert.equal((await signals([compactBare])).compactRequestedAt, Date.parse(TS), "bare /compact content");
assert.equal((await signals([compactXml])).compactRequestedAt, Date.parse(TS), "command-name /compact content");
// Anything newer from the conversation means the compaction is over (or was
// canceled and resumed) — the marker only holds while it is the newest user line.
assert.equal((await signals([compactBare, humanReplyLine])).compactRequestedAt, null, "cleared by a newer user line");
// A line that merely contains the string is not the command.
assert.equal((await signals([compactBare, mentionLine])).compactRequestedAt, null, "tool_result mentioning /compact is not a /compact");
console.log("OK: compaction start marker");

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
