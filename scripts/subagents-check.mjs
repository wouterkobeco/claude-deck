// Verifies the running-subagent scan: which agents under a session's
// subagents/ directory are still working, read from the newest stop_reason,
// and how they're retired when one is interrupted and never writes an ending.
// Run: node scripts/subagents-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunningSubagents } from "../src/sessions.mjs";

const dir = await mkdtemp(join(tmpdir(), "streamdeck-subagents-check-"));

const line = (stop_reason, type = "assistant") => JSON.stringify({ type, message: { stop_reason } });
const toolResultLine = JSON.stringify({
  type: "user",
  message: { content: [{ type: "tool_result", content: 'the docs say stop_reason is "end_turn" when done' }] },
});
const thinkingLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }] } });

async function agent(id, lines, { description = null, ageS = 0 } = {}) {
  const path = join(dir, `agent-${id}.jsonl`);
  await writeFile(path, lines.join("\n") + "\n");
  if (description) await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description }));
  if (ageS) {
    const t = new Date(Date.now() - ageS * 1000);
    await utimes(path, t, t);
  }
  return path;
}

const ids = async () => (await readRunningSubagents(dir)).map((a) => a.id).sort();

// A session that has never spawned one: no directory, no error.
assert.deepEqual(await readRunningSubagents(join(dir, "missing")), []);

// The case this exists for. Waiting on a tool is running; the thinking line
// after a tool result has no stop_reason of its own, so the scan keeps going
// back to the "tool_use" that means the agent is still mid-flight.
await agent("running", [line("tool_use"), toolResultLine, thinkingLine], { description: "Task 1: rename tables" });
// An agent that handed its result back writes end_turn and stops.
await agent("finished", [line("tool_use"), toolResultLine, line("end_turn")]);
// Spawned a moment ago, nothing written yet — running, not "unknown".
await agent("newborn", [JSON.stringify({ type: "user", message: { content: "go" } })]);
assert.deepEqual(await ids(), ["newborn", "running"]);

// The description off the .meta.json is what the tile reads; without one the
// id is all there is.
const running = (await readRunningSubagents(dir)).find((a) => a.id === "running");
assert.equal(running.description, "Task 1: rename tables");
assert.equal((await readRunningSubagents(dir)).find((a) => a.id === "newborn").description, null);

// Interrupted mid-tool: it never writes end_turn, so only the mtime cap
// retires it. Ten minutes quiet and the marker goes away.
await agent("interrupted", [line("tool_use")], { ageS: 11 * 60 });
assert.deepEqual(await ids(), ["newborn", "running"]);

// A tool result quoting "stop_reason" is not a stop_reason — same trap the
// /compact marker fell into. The parsed message is what counts.
await agent("quoting", [line("tool_use"), toolResultLine]);
assert.ok((await ids()).includes("quoting"), "a line merely mentioning end_turn does not end an agent");

await rm(dir, { recursive: true, force: true });
console.log("OK: running subagents");
