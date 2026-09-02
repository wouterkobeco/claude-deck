// Verifies the running-subagent scan: which agents under a session's
// subagents/ directory are still working, read from the newest stop_reason,
// and how they're retired when one is interrupted and never writes an ending.
// Run: node scripts/subagents-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCwds, readRunningSubagents } from "../src/sessions.mjs";

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

// Where the agent is working, off the same tail scan. An SDD controller
// dispatches into the worktree its plan lives in, and that path is the only
// way the *parent's* key can find the ledger — findWorkspace walks up only.
const inWorktree = JSON.stringify({ type: "assistant", cwd: "/repo/.claude/worktrees/wt", message: { stop_reason: "tool_use" } });
await agent("placed", [inWorktree]);
assert.equal((await readRunningSubagents(dir)).find((a) => a.id === "placed").cwd, "/repo/.claude/worktrees/wt");
// A transcript whose lines carry no cwd says so, rather than borrowing one.
assert.equal((await readRunningSubagents(dir)).find((a) => a.id === "newborn").cwd, null);
console.log("OK: an agent's own cwd");

// Attribution: only an agent this session spawned may answer for it. Eight
// sessions were open at the repo root where this was measured, and a plan
// found by scanning the tree downward would have landed on all eight.
const parent = { session_id: "s-1", cwd: "/repo" };
const agents = [
  { parent: "s-1", agentCwd: "/repo/.claude/worktrees/wt" },
  { parent: "s-1", agentCwd: "/repo/.claude/worktrees/wt" }, // same worktree, one entry
  { parent: "s-1", agentCwd: "/repo" }, // its own cwd, already tried first
  { parent: "s-1", agentCwd: null }, // nothing known about this one
  { parent: "s-2", agentCwd: "/repo/.claude/worktrees/other" }, // a sibling's agent
];
assert.deepEqual(agentCwds(parent, agents), ["/repo/.claude/worktrees/wt"]);
assert.deepEqual(agentCwds({ session_id: "s-3", cwd: "/repo" }, agents), [], "a session running none gets none");

// SDD alternates an Agent-tool implementer with an SDK reviewer, and the
// controller sits alone between them. The last place its own agent worked
// carries that gap, or the count blinks off and back on every dispatch.
assert.deepEqual(agentCwds(parent, []), ["/repo/.claude/worktrees/wt"], "remembered across a gap with nothing running");
assert.deepEqual(agentCwds({ session_id: "s-9", cwd: "/repo" }, []), [], "and never invented for a session that has never run one");
console.log("OK: only an agent this session spawned answers for it");

await rm(dir, { recursive: true, force: true });
console.log("OK: running subagents");
