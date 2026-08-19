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
import { CLAUDE, CODEX, collectTokens, compactTokens, groupTokens, readTokens, summariseTokens, HOUR_MS } from "../src/tokens.mjs";

const root = await mkdtemp(join(tmpdir(), "streamdeck-tokens-check-"));
const projects = join(root, "projects");
const slug = join(projects, "-Users-me-thing");
await mkdir(join(slug, "parent-id", "subagents"), { recursive: true });

const HOUR = Date.parse("2026-08-18T09:00:00.000Z");
// codexRoot is pointed at the fixture tree explicitly, never left to default:
// without it every assertion here counts whatever the real Codex CLI on this
// machine happens to have logged.
const codex = join(root, "codex-sessions");
await mkdir(join(codex, "2026", "08", "18"), { recursive: true });
// ledgerPath the same way, and for the same reason: left to default it reads
// this machine's real ship-review ledger and every count below is whatever
// happens to be on disk.
const ledger = join(root, "ship-reviews.jsonl");
const collect = () => collectTokens({ root, projectsRoot: projects, codexRoot: codex, ledgerPath: ledger });

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
  assert.equal(b.provider, CLAUDE, "and it is Claude's meter that ran");
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
const nowhere = { root, projectsRoot: join(root, "no-projects"), codexRoot: join(root, "no-codex"), ledgerPath: join(root, "no-ledger") };
assert.equal(await collectTokens(nowhere), 0, "a missing projects tree collects nothing");
assert.equal(await collectTokens(nowhere), 0, "and a machine with no Codex CLI or ship ledger is not an error either");

// --- Codex -----------------------------------------------------------------

// The ship-review skill drives `codex exec` for a second opinion, on another
// vendor's meter entirely. Same log, told apart by `provider`.
{
  const rollout = join(codex, "2026", "08", "18", "rollout-2026-08-18T09-00-00-abc.jsonl");
  const at = (minute) => new Date(HOUR + minute * 60000).toISOString();
  // A turn's usage, in the shape the Codex CLI writes it: `total_token_usage`
  // is cumulative for the session and `last_token_usage` is this turn's.
  const turn = (minute, out, { input = 100, cached = 40, reasoning = 0 }, totals) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: at(minute),
      payload: {
        type: "token_count",
        info: {
          total_token_usage: totals,
          last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: reasoning },
        },
      },
    });
  writeFileSync(
    rollout,
    [
      JSON.stringify({ type: "session_meta", timestamp: at(0), payload: { cwd: "/Users/me/thing", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", timestamp: at(0), payload: { model: "gpt-5.5" } }),
      turn(1, 300, {}, { output_tokens: 300 }),
      turn(2, 200, { input: 50, cached: 20 }, { output_tokens: 500 }),
    ].join("\n") + "\n"
  );

  assert.equal(await collect(), 1, "a codex session is one bucket for the hour");
  const b = readTokens(root).at(-1);
  assert.equal(b.provider, CODEX, "tagged as the other vendor's meter");
  assert.equal(b.model, "gpt-5.5", "with the model turn_context named");
  assert.equal(b.cwd, "/Users/me/thing", "and the cwd from the session header");
  // The one that matters. total_token_usage is cumulative and re-emitted every
  // turn, so summing it counts every turn once per turn that follows: on the
  // machine this was written on that inflated all-time output from 6.8M to
  // 79.6M, a factor of twelve, and nothing about the number looked wrong.
  assert.equal(b.out, 500, "per-turn usage is summed, never the cumulative total");
  // Codex's input_tokens is the whole prompt with the cached read as a subset,
  // where Claude's counts only what was neither — so the subset comes off, or
  // one column in one table means two different things.
  assert.equal(b.in, 90, "input net of the cached part, to match Claude's meaning");
  assert.equal(b.cacheRead, 60, "codex's cached input is a read");
  assert.equal(b.cacheWrite5m, 0, "and it reports no cache writes at all");
  assert.equal(b.calls, 2, "two turns");

  // Codex sessions are appended to for as long as the review runs, so the same
  // incremental contract applies — and its bookmarks share one map with the
  // transcripts', namespaced so a relative path from one tree cannot be read
  // as a path into the other.
  assert.equal(await collect(), 0, "a second pass over an unchanged session counts nothing");
  appendFileSync(rollout, turn(3, 7, {}, { output_tokens: 507 }) + "\n");
  assert.equal(await collect(), 1, "an appended turn is picked up");
  assert.equal(readTokens(root).at(-1).out, 7, "as its own delta, not the running total");

  // The two providers are separate buckets in the same hour, never merged.
  // Claude's side of this hour is re-established here on purpose: the
  // retention case above deliberately empties the log, so anything asserted
  // across both vendors has to put both of them back first.
  appendFileSync(transcript, msg(8, usage(214)) + "\n");
  assert.equal(await collect(), 1, "and a claude message in the same hour is its own bucket");
  const hour = summariseTokens(readTokens(root), HOUR, HOUR + HOUR_MS)[0];
  assert.equal(hour.out, 214 + 507, "one hour's total spans both vendors");
  const byProvider = groupTokens(readTokens(root), "provider", HOUR, HOUR + HOUR_MS);
  assert.deepEqual(byProvider.map((r) => `${r.provider}:${r.out}`), ["codex:507", "claude:214"], "and they are separable");
}

// --- the ship-review ledger ------------------------------------------------

// The metered rung is the one nothing else here can see: it runs under a
// second CODEX_HOME so an API key can never land in the ChatGPT login, and
// that tree is deliberately not scanned. The ledger is its source of record —
// and the only place on the machine that knows what a review cost.
{
  const review = (minute, reviewer, cost, tokens) =>
    JSON.stringify({
      ts: new Date(HOUR + minute * 60000).toISOString(),
      repo: "wouterkobeco/thing",
      reviewer,
      model: "gpt-5.6-terra",
      cost_usd: cost,
      tokens,
    });
  writeFileSync(
    ledger,
    [
      review(10, "codex-api", 0.43, { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 4108, reasoning_output_tokens: 2139 }),
      // Already counted from ~/.codex/sessions: ingesting it here would count
      // the same review twice.
      review(11, "codex", 0, { input_tokens: 900, cached_input_tokens: 0, output_tokens: 999 }),
      // A Fable review is a Claude subagent, already in its own transcript,
      // and the ledger records no tokens for it at all.
      review(12, "fable", 0, null),
    ].join("\n") + "\n"
  );

  assert.equal(await collect(), 1, "only the metered rung earns a bucket");
  const b = readTokens(root).at(-1);
  assert.equal(b.provider, "codex-api", "tagged as the rung that costs money");
  assert.equal(b.costUsd, 0.43, "with the money the ledger recorded");
  assert.equal(b.out, 4108, "and its output");
  assert.equal(b.calls, 1, "one ledger row is one review, not one turn");
  // input_tokens in both Codex sources is the whole prompt, with the cached
  // read and the cache write as subsets — where Claude's counts neither. The
  // subsets come off, or one table's column means two things.
  assert.equal(b.in, 300, "the prompt is stored net of its cached and written parts");
  assert.equal(b.cacheRead, 600, "which are kept as their own figures");
  assert.equal(b.cacheWrite, 100, "under the no-ttl-reported column, not the 5m one");
  assert.equal(b.cacheWrite5m, 0, "since Codex says nothing about how long its cache lives");
  assert.equal(await collect(), 0, "and the ledger is read incrementally like everything else");

  // A rollout lookup that failed writes `tokens: null` and still records the
  // money. The review happened and it was billed.
  appendFileSync(ledger, review(20, "codex-api", 1.5, null) + "\n");
  assert.equal(await collect(), 1, "a row with no tokens still counts for its cost");
  assert.equal(readTokens(root).at(-1).costUsd, 1.5, "which is the number that matters");
  assert.equal(readTokens(root).at(-1).out, 0, "and it claims no tokens it does not have");
}

// The bookmark drops transcripts that no longer exist rather than remembering
// every one this machine has ever written.
{
  const pos = JSON.parse(await readFile(join(root, "streamdeck-tokens.pos"), "utf8"));
  assert.deepEqual(
    Object.keys(pos).sort(),
    [
      "-Users-me-thing/parent-id/subagents/agent-abc.jsonl",
      "-Users-me-thing/session-a.jsonl",
      "codex/2026/08/18/rollout-2026-08-18T09-00-00-abc.jsonl",
      "ledger/ship-reviews.jsonl",
    ],
    "one bookmark per live file, relative to its own tree and namespaced by which tree that is"
  );
}

console.log("OK: token extraction, incremental reads, codex, the review ledger, grouping, compaction");
