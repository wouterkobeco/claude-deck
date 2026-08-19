// Token extraction: what gets lifted out of a transcript, what is deliberately
// not, and that a second pass counts only what appeared since the first.
//
// The incremental cases are the ones worth having. Re-reading a transcript
// whole would double every total in it, and a bookmark that advanced over a
// half-written line would lose one for good — both are silent, both are only
// visible a month later as a number that is wrong by an unknown amount.
// Run: node scripts/tokens-check.mjs
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTokens, compactTokens, groupTokens, readTokens, summariseTokens, HOUR_MS } from "../src/tokens.mjs";

const root = await mkdtemp(join(tmpdir(), "streamdeck-tokens-check-"));
const projects = join(root, "projects");
const slug = join(projects, "-Users-me-thing");
await mkdir(join(slug, "parent-id", "subagents"), { recursive: true });

const HOUR = Date.parse("2026-08-18T09:00:00.000Z");
const collect = () => collectTokens({ root, projectsRoot: projects });

// One assistant message, in the shape Claude Code writes it.
const msg = (minute, usage, { model = "claude-opus-5", cwd = "/Users/me/thing" } = {}) =>
  JSON.stringify({
    type: "assistant",
    cwd,
    timestamp: new Date(HOUR + minute * 60000).toISOString(),
    message: { model, usage },
  });

const usage = (out, { input = 3, think = 0, w5 = 0, w1h = 0, read = 0 } = {}) => ({
  input_tokens: input,
  output_tokens: out,
  output_tokens_details: { thinking_tokens: think },
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1h },
  cache_read_input_tokens: read,
});

const transcript = join(slug, "session-a.jsonl");
writeFileSync(transcript, [msg(1, usage(100, { w5: 500 })), msg(2, usage(50, { think: 20, read: 900 }))].join("\n") + "\n");

assert.equal(await collect(), 1, "two messages in one hour are one bucket");
{
  const [b] = readTokens(root);
  assert.equal(b.hour, HOUR, "bucketed to the top of the hour");
  assert.equal(b.out, 150, "output is summed");
  assert.equal(b.think, 20, "thinking tokens ride along");
  assert.equal(b.cacheWrite5m, 500, "cache writes are kept split by ttl");
  assert.equal(b.cacheRead, 900, "and cache reads separately again");
  assert.equal(b.calls, 2, "calls counts the messages");
  assert.equal(b.sub, false, "a top-level transcript is not a subagent's");
}

// The incremental contract: a pass counts bytes, not files. Re-reading the two
// lines above would silently double every total in this log.
assert.equal(await collect(), 0, "a second pass over unchanged transcripts counts nothing");
assert.equal(readTokens(root).length, 1, "and appends nothing");

appendFileSync(transcript, msg(3, usage(7)) + "\n");
assert.equal(await collect(), 1, "an appended message is picked up");
assert.equal(
  summariseTokens(readTokens(root), HOUR, HOUR + HOUR_MS)[0].out,
  157,
  "the new bucket sums with the old one rather than replacing it"
);

// A transcript is read while another process appends to it, so the last line is
// routinely half-written. Advancing the bookmark over it would drop it for good.
appendFileSync(transcript, '{"type":"assistant","message":{"usa');
assert.equal(await collect(), 0, "a half-written line is not counted");
appendFileSync(transcript, `ge":{"output_tokens":11}},"timestamp":"${new Date(HOUR + 4 * 60000).toISOString()}"}\n`);
assert.equal(await collect(), 1, "and is counted once it completes");
assert.equal(summariseTokens(readTokens(root), HOUR, HOUR + HOUR_MS)[0].out, 168, "exactly once, not twice");

// Nothing in a transcript line may be matched as a raw substring — the rule
// CLAUDE.md sets for readTranscriptSignals, and this reader quotes the same
// files. A session that greps its own log writes `"usage"` into it as text.
appendFileSync(transcript, JSON.stringify({ type: "user", message: { content: 'grep found "usage":{"output_tokens":99999}' } }) + "\n");
assert.equal(await collect(), 0, "a tool result quoting a usage object is not a usage object");

// A <synthetic> message — an API error, an interrupt, a cancelled turn — has a
// usage object of nothing but zeroes. It is a third of the rows in a real
// backfill and says nothing.
appendFileSync(transcript, msg(5, usage(0, { input: 0 }), { model: "<synthetic>" }) + "\n");
assert.equal(await collect(), 0, "an all-zero usage object earns no bucket");

// A subagent's transcript is four levels down, and telling it apart from its
// parent's is the split the deck cannot show — 38% of all calls on the machine
// this was written on.
const agent = join(slug, "parent-id", "subagents", "agent-abc.jsonl");
writeFileSync(agent, msg(6, usage(40)) + "\n");
assert.equal(await collect(), 1, "a subagent transcript at depth four is found");
assert.equal(readTokens(root).at(-1).sub, true, "and is marked as one");
assert.equal(summariseTokens(readTokens(root), HOUR, HOUR + HOUR_MS)[0].subCalls, 1, "subagent calls are counted apart");

// A file that shrank is a different file under the same name — a reused
// session id, or a truncated write. Trusting the old offset would skip its
// whole beginning.
writeFileSync(transcript, msg(7, usage(5)) + "\n");
assert.equal(await collect(), 1, "a shrunk transcript is re-read from zero");

// Hours with nothing in them are reported as zeroes rather than omitted: a
// chart that drops an idle hour draws a busy night out of four messages.
{
  const rows = summariseTokens(readTokens(root), HOUR - 2 * HOUR_MS, HOUR + HOUR_MS);
  assert.equal(rows.length, 3, "every hour in the window is present");
  assert.deepEqual(rows.map((r) => r.out), [0, 0, 213], "including the empty ones");
}

// Grouping answers "what did the spend go on", biggest first.
{
  const byModel = groupTokens(readTokens(root), "model", HOUR, HOUR + HOUR_MS);
  assert.deepEqual(byModel.map((r) => r.model), ["claude-opus-5", ""], "biggest first, and a missing model is its own group");
}

// Compaction is not housekeeping: a pass appends a bucket for the hour in
// progress, so a five-minute cadence writes a dozen rows for one hour. Summing
// them is right; storing them forever is not.
{
  const before = readTokens(root).length;
  const dropped = compactTokens(HOUR + HOUR_MS, root);
  const after = readTokens(root);
  assert.ok(dropped > 0, "duplicate hour buckets are merged");
  assert.equal(before - dropped, after.length, "and the count says how many went");
  assert.equal(summariseTokens(after, HOUR, HOUR + HOUR_MS)[0].out, 213, "totals survive the merge unchanged");
}

// Retention is what this file exists for: Claude Code deletes the transcripts
// at 30 days, so a bucket older than the window is the only copy there was.
{
  writeFileSync(join(root, "streamdeck-tokens.jsonl"), JSON.stringify({ hour: HOUR - 400 * 86400000, cwd: "x", model: "m", sub: false, out: 1 }) + "\n");
  assert.equal(compactTokens(HOUR, root), 1, "a bucket past the retention window is dropped");
  assert.equal(readTokens(root).length, 0, "leaving nothing behind");
}

// Nothing here may throw. This runs on the daemon's own timer, and a home
// directory it cannot read is a quiet zero, not a crash.
assert.deepEqual(readTokens(join(root, "nope")), [], "an unreadable log reads as nothing collected");
assert.equal(await collectTokens({ root, projectsRoot: join(root, "no-projects") }), 0, "a missing projects tree collects nothing");

// The bookmark drops transcripts that no longer exist rather than remembering
// every one this machine has ever written.
{
  const pos = JSON.parse(await readFile(join(root, "streamdeck-tokens.pos"), "utf8"));
  assert.deepEqual(Object.keys(pos).sort(), ["-Users-me-thing/parent-id/subagents/agent-abc.jsonl", "-Users-me-thing/session-a.jsonl"], "one bookmark per live transcript, keyed relative to the projects root");
}

console.log("OK: token extraction, incremental reads, grouping, compaction");
