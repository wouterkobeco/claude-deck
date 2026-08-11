// Verifies the aiTitle scan stops at the most recent /clear rather than
// surfacing a summary from a conversation that's already gone.
// Run: node scripts/title-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestAiTitle } from "../src/sessions.mjs";

const dir = await mkdtemp(join(tmpdir(), "streamdeck-title-check-"));
const path = join(dir, "transcript.jsonl");
const titleLine = (t) => JSON.stringify({ type: "assistant", aiTitle: t });
const clearLine = JSON.stringify({
  type: "user",
  message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" },
});

const write = (lines) => writeFile(path, lines.join("\n") + "\n");

await write([titleLine("Fix login bug")]);
assert.deepEqual(await readLatestAiTitle(path), { aiTitle: "Fix login bug", clearedEmpty: false });

await write([titleLine("Fix login bug"), clearLine, titleLine("Add rate limiting")]);
assert.deepEqual(await readLatestAiTitle(path), { aiTitle: "Add rate limiting", clearedEmpty: false });

// The case this exists for: an old title must not survive a /clear with
// nothing said since.
await write([titleLine("Fix login bug"), clearLine]);
assert.deepEqual(await readLatestAiTitle(path), { aiTitle: null, clearedEmpty: true });

assert.deepEqual(await readLatestAiTitle(join(dir, "missing.jsonl")), { aiTitle: null, clearedEmpty: false });

await rm(dir, { recursive: true, force: true });
console.log("OK: title survives /clear");
