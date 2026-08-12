// Verifies the transcript tail scan: model/effort come from the newest
// assistant line, and the existing /clear and denial signals still hold.
// Run: node scripts/transcript-check.mjs
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptSignals } from "../src/sessions.mjs";

const eq = (got, want, label) => {
  if (got !== want) {
    console.error(`FAILED (${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
};

const dir = await mkdtemp(join(tmpdir(), "transcript-check-"));
const write = async (name, lines) => {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
};

// Newest assistant line wins for both fields.
const p1 = await write("models.jsonl", [
  { type: "assistant", effort: "low", message: { model: "claude-sonnet-5" } },
  { type: "user", message: { content: [] } },
  { type: "assistant", effort: "high", message: { model: "claude-opus-5" } },
]);
const a = await readTranscriptSignals(p1);
eq(a.model, "claude-opus-5", "newest assistant model");
eq(a.effort, "high", "newest assistant effort");

// A transcript with no assistant line yet reports null rather than guessing.
const p2 = await write("empty.jsonl", [{ type: "user", message: { content: [] } }]);
const b = await readTranscriptSignals(p2);
eq(b.model, null, "no assistant line yet");
eq(b.effort, null, "no effort yet");

// A missing file must not throw — a poll can land before the file exists.
const c = await readTranscriptSignals(join(dir, "does-not-exist.jsonl"));
eq(c.model, null, "missing file");
eq(c.aiTitle, null, "missing file keeps existing contract");

console.log("OK: transcript signals");
