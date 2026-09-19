// Codex sessions: which rollouts are live, what a tail says, and the rate
// limits in the status line's shape.
// Run: node scripts/codex-check.mjs
import assert from "node:assert/strict";
import { codexRate, parseLsof, rolloutSignals } from "../src/codex.mjs";
import { remoteUsage } from "../src/usage.mjs";

const eq = (a, b, msg) => assert.deepEqual(a, b, msg);

// Only rollouts, first opener wins — the TUI holds its subagents' files too.
eq(
  parseLsof(
    [
      "p100",
      "fcwd",
      "n/Users/x/projects/app",
      "f52",
      "n/Users/x/.codex/sessions/2026/09/19/rollout-a.jsonl",
      "f53",
      "n/Users/x/.codex/logs_2.sqlite",
      "p200",
      "f9",
      "n/Users/x/.codex/sessions/2026/09/19/rollout-a.jsonl",
      "n/Users/x/.codex/sessions/2026/09/19/rollout-b.jsonl",
    ].join("\n")
  ),
  [
    { pid: 100, path: "/Users/x/.codex/sessions/2026/09/19/rollout-a.jsonl" },
    { pid: 200, path: "/Users/x/.codex/sessions/2026/09/19/rollout-b.jsonl" },
  ]
);

const line = (o) => JSON.stringify(o);
const turn = { type: "turn_context", payload: { model: "gpt-6-astra", effort: "low" } };
const prompt = (text, kinds = ["user.text"]) =>
  line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
const started = line({ timestamp: "2026-09-19T09:00:00Z", type: "event_msg", payload: { type: "task_started" } });
const complete = line({ timestamp: "2026-09-19T09:05:00Z", type: "event_msg", payload: { type: "task_complete" } });
const tokens = line({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 129200 }, model_context_window: 258400 },
    rate_limits: { primary: { used_percent: 7, window_minutes: 10080, resets_at: 1790413355 }, secondary: null },
  },
});

const idle = rolloutSignals(
  [line(turn), prompt("# AGENTS.md", ["agents_md.instructions"]), prompt("audit the app"), started, tokens, complete, ""],
  true
);
eq([idle.state, idle.ts, idle.lastPrompt, idle.context, idle.model, idle.effort], ["idle", Date.parse("2026-09-19T09:05:00Z") / 1000, "audit the app", 50, "gpt-6-astra", "low"]);
eq(rolloutSignals([line(turn), prompt("go"), started, tokens], true).state, "busy", "between task_started and task_complete: working");
eq(rolloutSignals([tokens], false).state, "busy", "no turn marker in a partial tail: a turn wrote past it");
eq(rolloutSignals([prompt("go")], true).state, "idle", "a whole file that never started a turn is idle");
// A tool output quoting a rollout is text inside a payload, never a line.
eq(rolloutSignals([started, line({ type: "response_item", payload: { type: "function_call_output", output: complete } })], true).state, "busy");

// Model survives a tail that lost its turn_context, for the same rollout.
rolloutSignals([line(turn), complete], true, "/r.jsonl");
eq(rolloutSignals([complete], false, "/r.jsonl").model, "gpt-6-astra");

// Codex's weekly-only plan -> the week row; remoteUsage reads it like a host's.
const rate = codexRate({ primary: { used_percent: 7, window_minutes: 10080, resets_at: 1790413355 }, secondary: null });
eq(rate, { seven_day: { used_percentage: 7, resets_at: 1790413355 } });
eq(codexRate(null), null);
const u = remoteUsage([rate], Date.parse("2026-09-19T12:00:00Z"));
eq([u.session, u.week], [null, 7]);

console.log("OK: codex rollouts, signals, and rate limits");

// Remote: the tree fetch's `c ` lines are the open rollouts, and stay out of
// the pid table; a path the host chose is held to a rollout's shape.
{
  const { splitTreeStream, isCodexRollout } = await import("../src/remote-fs.mjs");
  const r = "/home/u/.codex/sessions/2026/09/19/rollout-x.jsonl";
  const split = splitTreeStream(Buffer.from(`12 1 100 codex\nc /proc/12/fd ${r}\nc /proc/13/fd ${r}\nc /proc/14/fd /etc/passwd\n---\ntar`));
  eq(split.codex, [{ pid: 12, path: r }], "one rollout, first opener, nothing that isn't one");
  eq([...split.pids], [12], "and no pid from a `c ` line");
  eq(isCodexRollout(r), true);
  eq(isCodexRollout("/home/u/.codex/sessions/../../../etc/rollout-x.jsonl"), false, "no climbing out");
  eq(isCodexRollout("home/u/.codex/sessions/rollout-x.jsonl"), false, "absolute only");
  eq(isCodexRollout("/home/u/.codex/sessions/2026/secret.json"), false, "a rollout, not any file");
}
console.log("OK: remote codex listing");
