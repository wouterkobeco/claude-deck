// Verifies the running-subagent scan: which agents under a session's
// subagents/ directory are still working, read from the newest stop_reason,
// and how they're retired when one is interrupted and never writes an ending.
// Run: node scripts/subagents-check.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCwds, ledgerCwds, readRunningSubagents, readTeammates, projectSlug } from "../src/sessions.mjs";

const dir = await mkdtemp(join(tmpdir(), "streamdeck-subagents-check-"));

const line = (stop_reason, type = "assistant") => JSON.stringify({ type, message: { stop_reason } });
const toolResultLine = JSON.stringify({
  type: "user",
  message: { content: [{ type: "tool_result", content: 'the docs say stop_reason is "end_turn" when done' }] },
});
const thinkingLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }] } });

async function agent(id, lines, { description = null, name = null, ageS = 0 } = {}) {
  const path = join(dir, `agent-${id}.jsonl`);
  await writeFile(path, lines.join("\n") + "\n");
  if (description || name) await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description, name }));
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
// `teamName` is a separate question from `description`: only a caller who
// addressed the agent by name sets it, which is what makes it a teammate
// rather than an anonymous helper — "running" above never got one.
assert.equal(running.teamName, null, "an anonymous Task-tool call has no team name");

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

// Standing somewhere is not the same as owning its plan. A controller parked a
// finished ledger at the main checkout, and all ten sessions open there read it
// as theirs — an idle one-question session among them. Shared root: nobody
// claims it by cwd; a session alone at its root, or a nested one, still does.
{
  const rootOf = new Map([["s-1", "/repo"], ["s-2", "/repo"], ["s-4", "/repo/.claude/worktrees/wt"], ["n-1", "/repo"]]);
  const all = [
    { session_id: "s-1", cwd: "/repo" },
    { session_id: "s-2", cwd: "/repo" },
    { session_id: "s-4", cwd: "/repo/.claude/worktrees/wt" },
    { session_id: "n-1", cwd: "/repo", nested: true },
  ];
  const [s1, s2, s4, n1] = all;
  assert.deepEqual(ledgerCwds(s1, rootOf, all, agents), ["/repo/.claude/worktrees/wt"], "crowded: only its own agent's cwd");
  assert.deepEqual(ledgerCwds(s2, rootOf, all, agents), ["/repo/.claude/worktrees/other"], "a sibling's agent is still not its");
  assert.deepEqual(ledgerCwds(s4, rootOf, all, []), ["/repo/.claude/worktrees/wt"], "alone at its root: its own cwd");
  assert.deepEqual(ledgerCwds(n1, rootOf, all, []), ["/repo"], "a nested session has no key to mislabel and keeps its cwd");
  assert.deepEqual(ledgerCwds(s1, rootOf, [s1], []), ["/repo", "/repo/.claude/worktrees/wt"], "alone: own cwd first, as before");
}
console.log("OK: only an agent this session spawned answers for it");

// The signal that replaced end_turn. A background subagent doesn't end its
// turn, it stops and stays resumable — so Claude Code writes the ending in the
// *parent's* transcript instead, and the agent's own may never carry one.
{
  const dir2 = await mkdtemp(join(tmpdir(), "streamdeck-subagents-stops-"));
  const parentPath = join(dir2, "parent.jsonl");
  const subs = join(dir2, "subagents");
  await mkdir(subs, { recursive: true });
  await writeFile(join(subs, "agent-stopped.jsonl"), line("tool_use") + "\n");
  const notification = (id, at, status = "completed") =>
    JSON.stringify({
      type: "user",
      timestamp: at,
      message: {
        role: "user",
        content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n`,
      },
    });
  const stops = (lines) => writeFile(parentPath, lines.join("\n") + "\n");
  const runningNow = async () => (await readRunningSubagents(subs, undefined, parentPath)).map((a) => a.id);

  // The ordinary case since background agents became the default: an agent
  // that finished having never written end_turn.
  await stops([notification("stopped", new Date(Date.now() + 3000).toISOString())]);
  assert.deepEqual(await runningNow(), [], "a notified stop retires an agent its own transcript never ended");

  // Resumed — it has written since it was last notified, which the
  // notification itself warns about: "the same task-id may notify more than
  // once".
  await stops([notification("stopped", new Date(Date.now() - 60_000).toISOString())]);
  assert.deepEqual(await runningNow(), ["stopped"], "an agent that has written since its notification is running again");

  // An agent quoting a notification back is not a notification: it arrives as
  // a content array, which is the trap a raw substring falls into.
  await stops([
    JSON.stringify({
      type: "user",
      timestamp: new Date(Date.now() + 3000).toISOString(),
      message: { role: "user", content: [{ type: "tool_result", content: "<task-notification>\n<task-id>stopped</task-id>\n" }] },
    }),
  ]);
  assert.deepEqual(await runningNow(), ["stopped"], "a quoted notification does not retire an agent");

  // No parent transcript reachable: the old rules still stand on their own.
  assert.deepEqual((await readRunningSubagents(subs)).map((a) => a.id), ["stopped"], "without one, nothing changes");
  await rm(dir2, { recursive: true, force: true });
  console.log("OK: a stopped agent is retired by its parent's notification");
}

// A caller who named the Agent tool call gets teamName back; one who didn't
// gets null — description reads independently of it either way.
{
  const dir3 = await mkdtemp(join(tmpdir(), "streamdeck-subagents-team-"));
  async function namedAgent(id, lines, opts) {
    const path = join(dir3, `agent-${id}.jsonl`);
    await writeFile(path, lines.join("\n") + "\n");
    await writeFile(join(dir3, `agent-${id}.meta.json`), JSON.stringify(opts));
  }
  await namedAgent("t1", [line("tool_use")], { description: "Audit RBAC scope", name: "audit-compliance-expert" });
  const named = (await readRunningSubagents(dir3)).find((a) => a.id === "t1");
  assert.equal(named.teamName, "audit-compliance-expert", "a caller-given name comes through as teamName");
  assert.equal(named.description, "Audit RBAC scope", "description still reads independently of it");
  await rm(dir3, { recursive: true, force: true });
  console.log("OK: a named agent carries its team name apart from its description");
}

// readTeammates: a completely different mechanism from everything above — a
// named Agent call running as its own top-level session under
// ~/.claude/teams/, never an entry under subagents/ at all.
{
  const root = await mkdtemp(join(tmpdir(), "streamdeck-teammates-"));
  const cwd = "/repo/project";
  // A full UUID-shaped id, the same as a real session's — measured live,
  // the roster's own directory truncates to its first segment
  // ("~/.claude/teams/session-3cbc56b7/" for a session id starting
  // "3cbc56b7-..."), not the whole id readTeammates is called with.
  const leadId = "1234abcd-dead-beef-0000-111122223333";
  const teamName = `session-${leadId.split("-")[0]}`;
  const projDir = join(root, "projects", projectSlug(cwd));
  await mkdir(projDir, { recursive: true });
  await mkdir(join(root, "teams", teamName), { recursive: true });

  await writeFile(
    join(root, "teams", teamName, "config.json"),
    JSON.stringify({
      name: teamName,
      createdAt: Date.now() - 60_000,
      leadSessionId: leadId,
      members: [
        { agentId: `team-lead@${teamName}`, name: "team-lead", backendType: "in-process", cwd },
        { agentId: `reviewer@${teamName}`, name: "reviewer", backendType: "tmux", cwd },
        { agentId: `writer@${teamName}`, name: "writer", backendType: "tmux", cwd },
      ],
    })
  );

  const teammateLine = (agentName, extra = {}) =>
    JSON.stringify({ teamName, agentName, type: "assistant", message: { content: [] }, ...extra });

  // A running teammate: ordinary lines, no away marker.
  await writeFile(join(projDir, "reviewer-session.jsonl"), teammateLine("reviewer") + "\n");
  // A finished one: the newest line tagged for this team is the away marker
  // — Claude Code's own "done, available for another task" signal.
  await writeFile(
    join(projDir, "writer-session.jsonl"),
    [teammateLine("writer"), JSON.stringify({ teamName, agentName: "writer", type: "system", subtype: "away_summary" })].join(
      "\n"
    ) + "\n"
  );
  // A stray transcript tagged for no team at all — must never be mistaken
  // for one just because it happens to share the directory.
  await writeFile(join(projDir, "unrelated.jsonl"), JSON.stringify({ type: "user", message: {} }) + "\n");

  const teammates = await readTeammates({ session_id: leadId, cwd }, root);
  assert.deepEqual(teammates.map((t) => t.name).sort(), ["reviewer"], "a running teammate is found, a finished one is not");
  assert.equal(teammates[0].id, "reviewer-session", "its own transcript's filename is its session id");

  // No team at all — the ordinary case for almost every session.
  assert.deepEqual(await readTeammates({ session_id: "solo", cwd }, root), [], "a session with no team has none");

  await rm(root, { recursive: true, force: true });
  console.log("OK: readTeammates finds a running named teammate and excludes a finished one");
}

await rm(dir, { recursive: true, force: true });
console.log("OK: running subagents");
