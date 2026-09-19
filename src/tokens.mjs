// What the tokens went on: hourly totals lifted out of Claude Code's
// transcripts, into a log that outlives them.
//
// Every assistant message carries `message.usage` next to an ISO timestamp, so
// the whole history is already on disk — but only for a while. Claude Code
// deletes transcripts past `cleanupPeriodDays`, which defaults to 30, and it is
// doing it: the oldest transcript on this machine when this was written was
// exactly 32 days old. So a page that reads transcripts live can never answer
// anything about last quarter, no matter how it is cached. Copying the numbers
// out is the only way to keep them.
//
// A fifth file, by the bar CLAUDE.md sets: an append log with its own retention
// and its own reader, and nothing that already exists can hold it. It is the
// second thing the daemon writes on its own schedule rather than in answer to a
// press — history.mjs was the first, and this one is its sibling in every way
// except that its source is a directory of other people's files rather than the
// board's own state.
//
// Sixth file, and it is a bookmark rather than data: `streamdeck-tokens.pos`
// is which byte of each transcript has already been counted. It cannot live in
// the log — a bookmark is rewritten on every pass and the log is only ever
// appended to — and without it every pass would re-read 2GB and double every
// total.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
// The Codex CLI's own session log. The ship-review skill drives `codex exec`
// for a second opinion, and that work is invisible to everything above —
// different vendor, different plan, its own rate limit. Same shape of problem
// as Claude's transcripts and the same answer: read it here, keep it longer
// than the source does.
const CODEX_DIR = join(homedir(), ".codex", "sessions");
// The metered rung's own CODEX_HOME. The second home exists so an API key can
// never overwrite the ChatGPT login, and that separation is exactly what makes
// this tree readable as money: a rollout under here billed a key, one under
// `~/.codex` billed the plan. Same reader, priced on the way past.
//
// This replaced the ship-review ledger as the source of record for the metered
// rung, because the ledger was never the whole bill. It gets one line per
// *review*, and this home runs everything else that wants the API too —
// `codex exec` from any skill, and a review abandoned mid-triage that never
// writes its row. Seven days reading $0.00 against $41 actually spent is what
// that gap looked like. The rollouts are the thing that was always complete;
// the ledger's money was a subset of theirs, so reading both would count the
// reviews twice.
const CODEX_API_DIR = join(homedir(), ".codex-api", "sessions");

// $ per million tokens, as of September 2026, and deliberately the same four
// numbers the ship-review skill prices its own runs with. Input bills at three
// rates: fresh, a cache read (90% off), and a cache write — 1.25x fresh, so a
// write costs *more* than fresh input rather than less. A model this table has
// never heard of is counted for its tokens and for no money at all: an invented
// rate reads as a fact, which is the same reason the context gauge draws
// nothing for a model outside its own measured table. If these look wrong they
// are stale — https://developers.openai.com/api/docs/pricing, not a guess.
const RATES = {
  // Sol's promotional price, "available at least through November 21, 2026".
  sol: { in: 4.0, read: 0.4, write: 5.0, out: 20.0 },
  terra: { in: 2.0, read: 0.2, write: 2.5, out: 12.0 },
  luna: { in: 0.2, read: 0.02, write: 0.25, out: 1.2 },
};

/** What one turn's tokens cost, or 0 for a model with no rate on file. */
function priceOf(model, u) {
  const rate = RATES[Object.keys(RATES).find((tier) => model.includes(tier))];
  if (!rate) return 0;
  return (u.in * rate.in + u.cacheRead * rate.read + u.cacheWrite * rate.write + u.out * rate.out) / 1e6;
}
const logIn = (root) => join(root, "streamdeck-tokens.jsonl");
const posIn = (root) => join(root, "streamdeck-tokens.pos");

// A year, against history.mjs's month. These records are hourly buckets rather
// than one per event — measured at a few tens of KB per working day, where the
// state log runs at 250KB — so the same disk buys an order of magnitude more
// past. Keeping longer than the transcripts is the entire reason this file
// exists, so the number has to be well clear of Claude Code's 30-day cleanup.
export const RETENTION_DAYS = 365;

export const HOUR_MS = 3600_000;

/**
 * The fields worth keeping from one `message.usage`, and no others.
 *
 * Cache creation is split 5m/1h because those two are billed differently, and
 * the split is not recoverable once the transcript is gone — the same reason
 * `model` is kept rather than a "was it opus" flag. Thinking tokens are a
 * subset of `output`, kept because they answer "what did the reasoning cost"
 * and cost nothing to carry. Everything else in that object (`service_tier`,
 * `iterations`, `inference_geo`, the server-tool counters) is either derivable,
 * constant here, or answers a question nobody has asked; a field added later
 * simply starts from the day it was added, which is the honest trade for not
 * keeping all of it.
 */
function usageOf(u) {
  return {
    calls: 1,
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    think: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheWrite: 0,
    costUsd: 0,
    // Pre-`cache_creation` transcripts only carry the flat total. Falling back
    // to it under 5m rather than dropping it keeps old rows countable; the
    // split is simply unknown that far back, and 5m is what it was.
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

// `cacheWrite` is cache creation with no ttl reported — Codex writes cache and
// says nothing about how long it lives, and filing that under the 5m column
// would be a number that reads as a fact and is a guess. Total cache writes are
// the three of them summed.
// `costUsd` is the only non-token metric and the only float: money, priced from
// this row's own tokens, for the metered rung alone. Every other row is zero by
// construction, not by accident — a subscription turn is prepaid, not free.
const METRICS = ["calls", "in", "out", "think", "cacheWrite5m", "cacheWrite1h", "cacheWrite", "cacheRead", "costUsd"];

/**
 * Every token one transcript file has ever logged, summed straight from the
 * file rather than the hourly log below — `keyOf` throws per-agent identity
 * away by design (a bucket is per hour/cwd/model, not per session), so
 * answering "how much did this one agent cost" means reading its own
 * transcript instead. On demand only, the same trade `fetchAccountName`
 * makes: a subagent's transcript is a few tens of KB, and this is read once
 * per detail-panel open, never on a poll. Null for a path nothing can read —
 * a remote session's, or one that ended and was swept.
 */
export async function transcriptTokenTotal(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const totals = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
  for (const line of text.split("\n")) {
    if (!line.includes('usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // A Codex rollout: `last_token_usage` per turn, summed the same way
    // collectCodex does it (never the cumulative total — see there).
    const t = rec?.payload?.type === "token_count" ? rec.payload.info?.last_token_usage : null;
    const u = t ? null : rec?.message?.usage;
    if (!t && (!u || typeof u !== "object")) continue;
    const usage = t ? codexUsage(t) : usageOf(u);
    totals.in += usage.in;
    totals.out += usage.out;
    totals.cacheWrite += usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWrite;
    totals.cacheRead += usage.cacheRead;
  }
  return totals;
}

/**
 * The `owner/name` a folder's git origin points at, or null for anything that
 * isn't a checkout of one.
 *
 * This is what rolls money up to the project it was spent on. Every bucket's
 * `cwd` is now a real path — the metered rung's included, since its rollouts
 * record the folder they ran in — but a repo's spend arrives split across its
 * checkouts and its worktrees, and one project is one row. Matching those on a
 * basename was the obvious cheap answer and is the wrong one — `kob-trace`
 * names a folder here and a repo there only by coincidence, and a coincidence
 * that fails puts real money on the wrong project. The remote a folder actually
 * pushes to is a fact on disk instead. (Records written before the rollouts
 * were read carry the old ledger's `owner/name` in that field and answer null
 * here, which is why the caller keys them under themselves rather than
 * dropping them.)
 *
 * Read out of `.git/config` rather than shelled out to `git`: this runs per
 * table row when the activity page is opened, never on a poll, and a file read
 * is cheaper than a subprocess by enough that no cache is worth its staleness.
 * A **worktree**'s `.git` is a file pointing at `<repo>/.git/worktrees/<name>`,
 * so the suffix is stripped and the repo's own config is read — a worktree
 * pushes where its repo does, and this project makes real keys for worktree
 * sessions, so they must not read as repo-less. A worktree that has since been
 * *removed* has no `.git` left to follow, and its money is still real, so the
 * walk continues up the path until an ancestor is a checkout — `.claude/
 * worktrees/<name>` under a repo lands on that repo. This is a containing
 * directory rather than a name that looks similar: work done inside a checkout
 * belongs to it, and a nested checkout answers for itself first because it is
 * hit first. The walk stops at the home directory, so nothing ever reads
 * `~/.git`.
 *
 * A remote session's folder is another machine's path and simply isn't here,
 * which is the honest answer: this machine's CODEX_HOME holds this machine's
 * spend.
 */
export function repoOf(folder) {
  for (let at = folder; at; ) {
    const repo = repoAt(at);
    // `null` is a checkout that cannot be *named* — no origin, or a worktree
    // pointing nowhere — and that stops the walk: the folder is its own repo,
    // and its parent's remote is a different project's. Only `undefined`, "no
    // checkout here at all", keeps climbing.
    if (repo !== undefined) return repo;
    const up = dirname(at);
    // `up === at` is the filesystem root; the rest are the shapes a `cwd` takes
    // when it is not a path at all (a pre-rollout record's `owner/name`).
    if (up === at || up === "." || up === "/" || up === homedir()) return null;
    at = up;
  }
  return null;
}

/**
 * The repo one folder is itself a checkout of; `null` if it is a checkout that
 * cannot be named, `undefined` if it is not one at all.
 */
function repoAt(folder) {
  let gitDir = join(folder, ".git");
  let entry;
  try {
    entry = statSync(gitDir);
  } catch {
    return undefined; // nothing here — the caller keeps walking up
  }
  try {
    if (entry.isFile()) {
      const at = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1];
      if (!at) return null;
      gitDir = at.trim().replace(/\/worktrees\/[^/]+\/?$/, "");
    }
    // The first `url` of the origin section alone — `[^[]*?` cannot leave the
    // section, and `\b` keeps it off `pushurl`.
    const cfg = readFileSync(join(gitDir, "config"), "utf8");
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/.exec(cfg)?.[1]?.trim();
    if (!url) return null;
    // Both spellings GitHub hands out end in the same two segments:
    // `git@host:owner/name.git` and `https://host/owner/name`.
    const parts = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : null;
  } catch {
    return null; // not a checkout, not readable, or not on this machine
  }
}

// Which vendor's meter ran. Records written before this field existed are
// Claude's, so it defaults rather than being required — and it is the seam any
// future split goes through, including the one this cannot yet see: nothing in
// a transcript says whether a turn was billed to the subscription or to the
// API (no costUSD, no apiKeySource, service_tier is "standard" on all of it),
// so when that becomes findable it is another provider value here, not another
// column.
export const CLAUDE = "claude";
export const CODEX = "codex";
// The metered rung, and the only one that costs money per turn. Which home a
// rollout was found under is what says whether it ran here or on the plan — the
// only thing on disk that knows, and the reason the two trees are read
// separately rather than as one.
export const CODEX_API = "codex-api";

// One bucket per hour per cwd per model per kind. `sub` is whether the
// transcript sat under a `subagents/` directory — an Agent-tool subagent
// writes there and nowhere else, and it turned out to be 38% of all calls on
// this machine, which is exactly the split the deck cannot show you.
const keyOf = (b) => `${b.hour}|${b.cwd}|${b.model}|${b.sub ? 1 : 0}|${b.provider ?? CLAUDE}`;

function addTo(buckets, hour, cwd, model, sub, usage, provider = CLAUDE) {
  const b = { hour, cwd, model, sub, provider };
  const key = keyOf(b);
  const found = buckets.get(key) ?? Object.assign(b, Object.fromEntries(METRICS.map((m) => [m, 0])));
  for (const m of METRICS) found[m] += usage[m];
  buckets.set(key, found);
}

/**
 * The bytes of one file past `from`, and where the last complete line ends.
 *
 * Shared by both collectors because both read files another process is
 * appending to, where the last line is routinely half-written: the cursor may
 * only advance over bytes that ended in a newline.
 */
async function newLines(path, from, size) {
  let fh;
  try {
    fh = await open(path);
    const buf = Buffer.alloc(size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const complete = text.lastIndexOf("\n");
    if (complete < 0) return null; // nothing but a partial line so far
    return { lines: text.slice(0, complete).split("\n"), at: from + Buffer.byteLength(text.slice(0, complete + 1), "utf8") };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Every `.jsonl` under `projectsRoot`, at any depth.
 *
 * Depth matters: a subagent's transcript is four levels down
 * (`<slug>/<parent id>/subagents/agent-*.jsonl`), and remote-fs.mjs already
 * has the scar from a glob that could not reach it.
 */
async function transcriptPaths(projectsRoot) {
  try {
    return (await readdir(projectsRoot, { recursive: true })).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return []; // no projects directory — nothing has ever run here
  }
}

function readPositions(root) {
  try {
    const parsed = JSON.parse(readFileSync(posIn(root), "utf8"));
    // Same rule as readAccents: a half-written or hand-edited file must not
    // put arbitrary values into arithmetic that decides what gets counted.
    return new Map(Object.entries(parsed).filter(([, v]) => typeof v === "number" && v >= 0));
  } catch {
    return new Map(); // first run, or unreadable — backfill from byte 0
  }
}

/**
 * Count the bytes of every transcript that have appeared since the last pass.
 *
 * Incremental by byte offset rather than by mtime: a transcript is appended to
 * for hours, so "changed since last time" is true of a 1.2MB file that grew by
 * one line, and re-reading it whole would double every total in it. Transcripts
 * only ever grow, so the offset is a safe bookmark — a file that has *shrunk*
 * is a different file under the same name (a session id reused, or a truncated
 * write) and is re-read from zero.
 *
 * A partial trailing line is left for next time: this reads a file another
 * process is appending to, so the last line is routinely half-written. The
 * cursor advances only over bytes that ended in a newline, which is what makes
 * that safe rather than lossy.
 *
 * Returns how many buckets were appended. Best-effort throughout, like every
 * other reader here: one unreadable transcript is skipped, not fatal.
 */
export async function collectTokens({
  now = Date.now(),
  root = CLAUDE_DIR,
  projectsRoot = join(root, "projects"),
  codexRoot = CODEX_DIR,
  codexApiRoot = CODEX_API_DIR,
  remoteApiReaders = {},
} = {}) {
  const previous = readPositions(root);
  // Once: the metered rows written while the model lookup was broken priced a
  // quarter of the bill at $0 (see collectCodex). Every rollout is still on
  // disk, so they are dropped and re-read from byte 0 rather than patched —
  // here, inside the pass, because this pass is the only writer of either file
  // and a repair from outside could interleave with one.
  if (!previous.has(REPRICED)) {
    dropProvider(root, CODEX_API);
    for (const k of [...previous.keys()]) if (k.startsWith(`${CODEX_API}/`)) previous.delete(k);
  }
  // Rebuilt from the paths that exist *now* rather than mutated in place: Claude
  // Code deletes transcripts past its cleanup period, and a map that only ever
  // gained keys would carry a bookmark per transcript this machine has ever
  // written, forever, for files nothing will read again.
  const positions = new Map([[REPRICED, 1]]);
  const buckets = new Map();
  let moved = !previous.has(REPRICED);

  for (const name of await transcriptPaths(projectsRoot)) {
    const path = join(projectsRoot, name);
    let size;
    try {
      ({ size } = await stat(path));
    } catch {
      continue; // vanished between readdir and stat
    }
    const seen = previous.get(name) ?? 0;
    const from = seen > size ? 0 : seen;
    positions.set(name, from);
    if (from >= size) continue;

    const slice = await newLines(path, from, size);
    if (!slice) continue;
    const sub = name.includes("/subagents/");
    for (const line of slice.lines) {
      // Cheap pre-filter, then the line's own parsed JSON decides — the same
      // rule readTranscriptSignals lives by, and for the same reason: a
      // transcript quotes tool output verbatim, so "usage" appears inside
      // prose and inside other transcripts printed into this one.
      if (!line.includes('"usage"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      const ts = Date.parse(rec?.timestamp ?? "");
      if (!u || typeof u !== "object" || Number.isNaN(ts)) continue;
      const usage = usageOf(u);
      // A `<synthetic>` message — an API error, an interrupt, a cancelled turn
      // — carries a usage object of nothing but zeroes. Counting those buys a
      // bucket per hour per session saying nothing happened, which is a third
      // of the rows on this machine's first backfill.
      if (!METRICS.some((m) => m !== "calls" && usage[m] > 0)) continue;
      addTo(buckets, Math.floor(ts / HOUR_MS) * HOUR_MS, rec.cwd ?? "", rec.message?.model ?? "", sub, usage, CLAUDE);
    }
    positions.set(name, slice.at);
    moved = true;
  }

  if (await collectCodex(localCodexReader(codexRoot), previous, positions, buckets, CODEX)) moved = true;
  if (await collectCodex(localCodexReader(codexApiRoot), previous, positions, buckets, CODEX_API)) moved = true;
  // Another machine's metered home bills the same key. Its bookmarks carry the
  // host, and a host that can't answer this pass simply keeps its cursor.
  for (const [host, reader] of Object.entries(remoteApiReaders)) {
    try {
      if (await collectCodex(reader, previous, positions, buckets, CODEX_API, `${CODEX_API}@${host}`)) moved = true;
    } catch {
      for (const [k, v] of previous) if (k.startsWith(`${CODEX_API}@${host}/`)) positions.set(k, v);
    }
  }

  if (!moved) return 0;
  try {
    if (buckets.size) {
      appendFileSync(logIn(root), [...buckets.values()].map((b) => JSON.stringify(b)).join("\n") + "\n");
    }
    // Written after the log, never before: a crash between the two re-counts a
    // few lines on the next pass, where the other order would drop them for
    // good. Over-counting is visible and fixable; a hole is neither.
    writeFileSync(posIn(root), JSON.stringify(Object.fromEntries(positions)));
  } catch {
    // Out of disk, or a read-only home. The next pass tries again from the
    // bookmark that did get written.
    return 0;
  }
  return buckets.size;
}

/**
 * The same pass over the Codex CLI's session logs, into the same buckets.
 *
 * **`last_token_usage`, never `total_token_usage`.** Codex emits a
 * `token_count` event per turn carrying both, and the total is *cumulative for
 * the session* — re-emitted, larger, on every turn. Summing those counts every
 * turn once per turn that follows it; on this machine that inflated the
 * all-time figure from 6.8M output tokens to 79.6M, a factor of twelve, and
 * nothing about the number would have looked wrong. The per-turn field sums to
 * exactly the final total, verified against the longest session on disk.
 *
 * `cwd` and `model` live in the session header and in `turn_context`, which a
 * byte cursor has usually already passed, so the head of the file is re-read
 * for them rather than remembered — one small read per changed file, against
 * carrying a second kind of value in the bookmark.
 *
 * Bookmarks are namespaced, because both trees are keyed by a relative path
 * into one map and only the prefix says which tree a name belongs to.
 */
/**
 * Codex's token fields in this file's shape.
 *
 * **`input_tokens` there is the whole prompt**, with the cached read and the
 * cache write as *subsets* of it — where Claude's `input_tokens` counts only
 * what was neither. Storing Codex's raw figure under the same name would make
 * the two vendors' columns mean different things in one table, so the subsets
 * come off. Clamped at zero rather than trusted: these come from another tool's
 * arithmetic, and a negative would sum silently into every total above it.
 */
function codexUsage(t) {
  const cached = t.cached_input_tokens ?? 0;
  const written = t.cache_write_input_tokens ?? 0;
  return {
    calls: 1,
    in: Math.max(0, (t.input_tokens ?? 0) - cached - written),
    out: t.output_tokens ?? 0,
    think: t.reasoning_output_tokens ?? 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: written,
    cacheRead: cached,
    costUsd: 0,
  };
}

// How much of a rollout's head is read for its `session_meta` (the cwd): the
// header line runs to ~22KB.
export const CODEX_HEAD_BYTES = 65536;

/**
 * This machine's side of a Codex tree, in the shape a remote host's reader
 * (remote-fs.mjs's `codexTreeReader`) has too: `list` names every rollout with
 * its size, and `fetch` answers, per file, three things in one go — its head
 * (for the cwd), the last `turn_context` line before the cursor (the model the
 * cursor is standing in), and the bytes from the cursor to the listed size.
 */
export function localCodexReader(root) {
  return {
    async list() {
      let names;
      try {
        names = (await readdir(root, { recursive: true })).filter((n) => n.endsWith(".jsonl"));
      } catch {
        return []; // no Codex here
      }
      const out = [];
      for (const name of names) {
        try {
          out.push({ name, size: (await stat(join(root, name))).size });
        } catch {} // vanished between readdir and stat
      }
      return out;
    },
    async fetch(requests) {
      return Promise.all(
        requests.map(async ({ name, from, size }) => {
          const path = join(root, name);
          const head = await readRange(path, 0, Math.min(size, CODEX_HEAD_BYTES));
          const before = from ? await readRange(path, 0, from) : null;
          const lastTurn = before
            ?.toString("utf8")
            .split("\n")
            // At the start of the line: anywhere else it is a tool output
            // quoting one.
            .findLast((l) => /^\{"timestamp":"[^"]*","type":"turn_context"/.test(l)) ?? null;
          return { head, lastTurn, slice: await readRange(path, from, size) };
        })
      );
    },
  };
}

async function readRange(path, from, to) {
  let fh;
  try {
    fh = await open(path);
    const buf = Buffer.alloc(Math.max(0, to - from));
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * One Codex tree into the buckets. `prefix` namespaces its bookmarks — the
 * provider, and the host for a remote tree — since every tree is keyed by a
 * relative path into one map.
 *
 * **The model is the last `turn_context` before the cursor**, then each one
 * the new bytes pass. It used to be looked for in the first 64KB only, and in
 * 208 of 261 metered rollouts the first `turn_context` starts past that: every
 * pass after the first read of such a file bucketed its turns with no model,
 * which prices at $0 — a quarter of the metered bill, missing.
 */
async function collectCodex(reader, previous, positions, buckets, provider = CODEX, prefix = provider) {
  let moved = false;
  const due = [];
  for (const { name, size } of await reader.list()) {
    const key = `${prefix}/${name}`;
    const seen = previous.get(key) ?? 0;
    const from = seen > size ? 0 : seen;
    positions.set(key, from);
    if (from < size) due.push({ key, name, from, size });
  }
  if (!due.length) return false;
  const fetched = await reader.fetch(due);

  due.forEach(({ key, from }, i) => {
    const got = fetched?.[i];
    if (!got?.slice) return;
    let cwd = "";
    let model = "";
    for (const line of [...(got.head?.toString("utf8").split("\n") ?? []), got.lastTurn ?? ""]) {
      if (!line.includes('"cwd"') && !line.includes('"model"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type === "session_meta") cwd = rec.payload?.cwd ?? cwd;
        if (rec?.type === "turn_context") model = rec.payload?.model ?? model;
      } catch {
        // truncated head — the bucket falls back to an empty cwd or model
      }
    }

    // Only whole lines count, and the cursor advances over exactly those: the
    // file is being appended to, so the last line is routinely half-written.
    const text = got.slice.toString("utf8");
    const complete = text.lastIndexOf("\n");
    if (complete < 0) return;
    for (const line of text.slice(0, complete).split("\n")) {
      if (!line.includes('"token_count"') && !line.includes('"model"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      // A turn can switch model mid-session, and turn_context is where it says
      // so — read it as the lines go by rather than trusting the header.
      if (rec?.type === "turn_context") model = rec.payload?.model ?? model;
      const info = rec?.payload?.type === "token_count" ? rec.payload.info : null;
      const last = info?.last_token_usage;
      const ts = Date.parse(rec?.timestamp ?? "");
      if (!last || Number.isNaN(ts)) continue;
      const usage = codexUsage(last);
      // Per turn, not per session: the turn is where the model is known for
      // certain (a session can switch mid-way) and where the timestamp is, so
      // the money lands in the hour that spent it like every other bucket here.
      if (provider === CODEX_API) usage.costUsd = priceOf(model, usage);
      if (!METRICS.some((m) => m !== "calls" && usage[m] > 0)) continue;
      addTo(buckets, Math.floor(ts / HOUR_MS) * HOUR_MS, cwd, model, false, usage, provider);
    }
    positions.set(key, from + Buffer.byteLength(text.slice(0, complete + 1), "utf8"));
    moved = true;
  });
  return moved;
}

// The bookmark that says the metered rows have been re-priced (collectTokens).
// A number, since readPositions keeps nothing else.
const REPRICED = "codex-api-repriced@1";

function dropProvider(root, provider) {
  try {
    const kept = readFileSync(logIn(root), "utf8")
      .split("\n")
      .filter((line) => {
        if (!line) return false;
        try {
          return JSON.parse(line)?.provider !== provider;
        } catch {
          return true;
        }
      });
    writeFileSync(logIn(root), kept.length ? kept.join("\n") + "\n" : "");
  } catch {} // no log yet
}

/** Every parseable bucket, in file order. A bad line is skipped, not fatal. */
export function readTokens(root = CLAUDE_DIR) {
  try {
    return readFileSync(logIn(root), "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const rec = JSON.parse(line);
          return typeof rec?.hour === "number" ? [rec] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return []; // nothing collected yet
  }
}

/**
 * Totals per `step`-wide bucket over `[from, to)`, oldest first, with every
 * bucket in the window present even when nothing ran in it.
 *
 * The gaps are the point: a bar chart that silently omits an idle hour draws a
 * busy night out of four scattered messages. Buckets are summed rather than
 * replaced, because a pass appends a partial hour and the next pass appends the
 * rest of it — `compactTokens` merges those eventually, and this must be right
 * before it has.
 *
 * `step` is what lets one chart cover a day and a year: the stored records are
 * hourly, so anything coarser is a regrouping rather than a re-read. It has to
 * be a whole number of hours, which every caller's is; a finer one would ask
 * for detail that was never kept.
 */
export function summariseTokens(records, from, to, step = HOUR_MS) {
  const size = Math.max(HOUR_MS, Math.round(step / HOUR_MS) * HOUR_MS);
  const start = Math.floor(from / size) * size;
  const buckets = new Map();
  for (let h = start; h < to; h += size) {
    // `outBy` is the same output split by whose meter ran, so a stacked bar
    // needs no second pass over the records — one chart, two vendors, and a
    // bucket that predates the field counts as Claude's.
    buckets.set(h, Object.fromEntries([["hour", h], ["subCalls", 0], ["apiCalls", 0], ["outBy", {}], ...METRICS.map((m) => [m, 0])]));
  }
  for (const rec of records) {
    const row = buckets.get(Math.floor(rec.hour / size) * size);
    if (!row) continue;
    for (const m of METRICS) row[m] += rec[m] ?? 0;
    if (rec.sub) row.subCalls += rec.calls ?? 0;
    const p = rec.provider ?? CLAUDE;
    row.outBy[p] = (row.outBy[p] ?? 0) + (rec.out ?? 0);
    // Turns, not runs: a rollout is read per `token_count` event, so this is
    // how many billed round-trips the window holds. The caption says "turns"
    // for that reason — it used to say "runs" when one ledger row was one
    // review, and the word had to follow the meaning.
    if (p === CODEX_API) row.apiCalls += rec.calls ?? 0;
  }
  return [...buckets.values()];
}

/** The oldest bucket on record, or null. What "all time" starts from. */
export function earliestBucket(records) {
  return records.length ? Math.min(...records.map((r) => r.hour)) : null;
}

/**
 * Totals grouped by one bucket field, biggest first — `model` for what the
 * spend went on, `cwd` for which project it went on.
 */
export function groupTokens(records, field, from, to) {
  const groups = new Map();
  for (const rec of records) {
    if (rec.hour < from || rec.hour >= to) continue;
    // Same defaulting as everywhere else: a record written before `provider`
    // existed is Claude's, and grouping by it must not invent a "" vendor.
    const key = (field === "provider" ? rec.provider ?? CLAUDE : rec[field]) ?? "";
    const row = groups.get(key) ?? Object.fromEntries([[field, key], ...METRICS.map((m) => [m, 0])]);
    for (const m of METRICS) row[m] += rec[m] ?? 0;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => b.out - a.out);
}

/**
 * Drop buckets past the retention window and merge what's left.
 *
 * The merge is not housekeeping — it is what keeps the log from growing with
 * the *poll rate* instead of with time. Every pass appends a fresh bucket for
 * the hour in progress, so a five-minute cadence writes a dozen rows for one
 * hour; summing them is correct but storing them forever is not. Same shape as
 * trimHistory: a whole-file rewrite, so it runs at startup and then once a day.
 *
 * Returns how many records the file lost, so the caller can say nothing
 * happened. A failed rewrite leaves the original, which still summarises
 * correctly — just larger.
 */
export function compactTokens(now = Date.now(), root = CLAUDE_DIR) {
  const cutoff = now - RETENTION_DAYS * 86400000;
  const records = readTokens(root);
  const merged = new Map();
  for (const rec of records) {
    if (rec.hour < cutoff) continue;
    const key = keyOf(rec);
    const row = merged.get(key);
    if (!row) {
      merged.set(key, { ...rec });
      continue;
    }
    for (const m of METRICS) row[m] = (row[m] ?? 0) + (rec[m] ?? 0);
  }
  if (merged.size === records.length) return 0;
  try {
    const out = [...merged.values()].sort((a, b) => a.hour - b.hour);
    writeFileSync(logIn(root), out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""));
    return records.length - merged.size;
  } catch {
    return 0;
  }
}
