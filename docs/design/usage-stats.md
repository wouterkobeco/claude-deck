# Usage, stats, history and tokens

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/usage.mjs` — the two rate-limit windows for the bottom-right key. These
  numbers exist only server-side, so it reads the CLI's own OAuth token from the
  login keychain and asks the API, cached 5 minutes. The only outbound network
  call in the project, and the only credential it touches. **That endpoint is
  shared, and it 429s you for other clients' traffic.** Every Claude Code
  session on the machine polls it with the same token; measured over 21
  requests at a strict 1/min, 19% came back 429 — including the first request
  from a cold process. It sends no ratelimit headers and answers
  `retry-after: 0`, so there is nothing to obey: each consecutive 429 waits one
  TTL longer (5m, 10m, 20m, capped at 30m) and one success drops back to the
  plain TTL. Don't shorten the TTL to make the key livelier — these are 5-hour
  and 7-day windows, and the cost of asking more often is paid in 429s. Set
  `USAGE_LOG=1` to append one line per request (timing, status, headers, live
  session count) to `~/.claude/streamdeck-usage.jsonl` before changing any of
  this.
  **A `cswap switch` rewrites the keychain item instantly, but the cached
  numbers have no way to know until something asks it again.** Without a
  separate check, the TTL alone decides that — up to 5 minutes of the old
  account's percentage under the new account's key, the bug this was written
  to fix. `watchIdentity` compares a fingerprint of the access token
  (`sha256`, truncated, never the token itself — the same reason cswap's own
  `credential_fingerprint` exists) on its own 10-second cadence, independent
  of and much faster than the usage TTL; a change resets `cache.at` to 0,
  which is what makes the *next* `getUsage()` call do a real fetch regardless
  of how much TTL is left. `subscriptionType`/`rateLimitTier` alone — what
  `subscriptionChange` already compared — isn't enough on its own: two
  accounts on the same plan share both fields, and a switch between them
  would go unnoticed. Never awaited from `getUsage`'s own path — fire-and-
  forget, the same shape `getMemory()` uses, because a keychain read is local
  but not guaranteed instant, and trading a stale-for-one-more-poll account
  for a stalled poll every 2s would be the wrong swap.
- `src/stats.mjs` — all-time stats board (favorite model, total tokens,
  sessions, ...), read from `~/.claude/stats-cache.json`, cached 30s. Values are
  validated against a real screenshot of the source tool's own output; don't
  change the formatting helpers without re-checking against a real cache file.
  It returns exactly seven tiles, all of which the activity page shows; none
  are on the deck any more (`stats-check` pins the count).
- `src/cswap.mjs` — the other subscriptions, read off claude-swap's own files
  (`~/.claude-swap-backup/sequence.json` for the slots and which is active,
  `cache/usage.json` for each one's last-good 5h/7d window and reset time).
  cswap polls the same `/api/oauth/usage` endpoint `usage.mjs` does, once per
  stored token, so the inactive accounts' numbers are already on disk and this
  fetches nothing and touches no credential. Both files are another tool's
  format: any failure reads as "cswap isn't installed" and yields `[]`, which
  the stats board draws as empty keys and the activity page as no block at all.
- `src/history.mjs` — where the time goes: an append-only log of every session
  state change, and the per-project totals read back out of it. The daemon has
  watched every session's state every 2s since it was written and persisted
  none of it — nothing else on this machine has that view (`stats.mjs`'
  all-time numbers are another tool's cache), so "which project ate an hour of
  waiting for me to approve things" was unanswerable from data passing through
  here thirty times a minute.
  **A fourth file** (`~/.claude/streamdeck-history.jsonl`) rather than another
  key in the accents record: an append log with its own retention and its own
  reader is exactly the bar the read-only invariant sets for adding one.
  `recordStates` writes **only on change**, so a session busy for an hour is
  one record rather than 1,800, and it emits a `gone` record when a session
  disappears — without that, the final state of every session that ever ran
  counts up to `now` forever. Nested sessions are skipped: a subagent's time
  already reaches its project through its parent's own state, and counting both
  double-counts every minute a parent spent waiting on one.
  `summarise` takes `now` as an argument rather than reading the clock, because
  the last record of a live session is an **open interval** that runs to now —
  the one place this would silently start lying (get it wrong and every current
  session contributes zero, which reads as "nothing happened today"), and the
  reason it has to be reproducible for a check. Intervals are clipped to the
  window, so a session busy since yesterday owes today only today's share, and
  everything is attributed **by folder**: session ids are ephemeral and the
  question is about projects. Trimming is a whole-file rewrite, so it runs at
  startup and then once per local day, off the day boundary the summary already
  computes.
  **`concurrency` answers the question durations cannot**: eight hours of busy
  is one session all day or eight at once, and those are different machines. It
  walks the same intervals with a 5-minute sampling clock and reports an hourly
  high-water mark. Two things in it are load-bearing. **`states` is the split at
  the busiest sample, not a peak per state** — per-state maxima happen at
  different minutes, so they sum to more than the hour ever held and a stacked
  bar drawn from them runs off the end of its own track; the cost is that a
  session blocked at a quieter minute isn't in that chart, which is what the
  table's blocked column is for. And **unobserved time is reported as
  unobserved**: a change-only log cannot tell a sleeping machine from a quiet
  one, because five idle sessions overnight produce exactly as many records as a
  daemon that isn't running, which is none. That is what `TICK` is for —
  `recordTick` writes one line every `TICK_MS` (5 min) saying the daemon was
  watching, `OUTAGE_MS` is three of those, and a sample inside a longer gap is
  dropped rather than counted. Without it this machine's own log drew a ten-hour
  sleep as six sessions working all night, which is the shape the bug takes.
  Ticks carry `kind` and no `id`; every reader that walks records skips them,
  and `summarise` is the one that would otherwise grow a phantom project.
  **Ticks also carry memory** (`mem`, `swap`, whole percentages) when the
  daemon had a reading: a five-minute sample is the cadence a pressure series
  wants, and riding the tick costs no new file and no new cadence.
  **A remote host's memory rides the tree fetch**: `TREE_CMD` prints
  `/proc/meminfo` behind its own `===` fence ahead of the pid table, and the
  table now carries `rss` and `comm`, so `splitTreeStream` yields a `memory`
  of the same shape `getMemory` gives (`parseMeminfo`: pressure is what isn't
  `MemAvailable`) — no extra round trip, and a host with no `/proc/meminfo`
  (a Mac) reports `null` rather than zeros. It reaches the board through the
  source, read off `remoteMemo` like `ppids` (`hostMemories`): a stats key per
  host in the memory key's shape, a meter pair per machine on the activity
  page, `statusKey` alerting on the *worst* machine with its name where
  `MEMORY` goes, and `hosts` on the tick for a pressure chart per host — a
  host that has gone away keeps its history, since `memoryHosts` walks the
  records rather than the live memo.
  They carry the Claude sessions' own resident footprint too (`cl` MB, `cln`
  processes, off `ps -axo rss=,comm=` matched on the `claude` basename) —
  resident only, so a floor: what's swapped out is invisible to ps.
  `memorySeries` keeps each bucket's *maximum*, not its mean — a day-wide bar
  that averages a two-hour swap storm into 30% hides the thing the chart is
  for — and the activity page draws it against a fixed 100, red over
  `MEMORY_ALERT_PCT`, with unwatched buckets striped like the sessions chart. The sessions'
  footprint is a chart of its own under "Sessions in parallel", scaled to
  its busiest column like the token charts (an amount, not a share), and the
  count shown beside a bucket's high-water mark is the count *at* that sample.
- `src/tokens.mjs` — what the tokens went on: hourly totals lifted out of
  Claude Code's transcripts, into a log that outlives them. Every assistant
  message carries `message.usage` beside an ISO timestamp, so the history is
  already on disk — for 30 days, and then it is gone (see the read-only
  invariant below). **Incremental by byte offset, never by mtime**: a transcript
  is appended to for hours, so "changed since last time" is true of a 1.2MB file
  that grew by one line, and re-reading it whole doubles every total in it. A
  partial trailing line is left for next time — this reads a file another
  process is writing, so the last line is routinely half-written, and the cursor
  advances only over bytes that ended in a newline. A file that has *shrunk* is
  a different file under the same name and is re-read from zero. Records are
  hourly buckets keyed by `(hour, cwd, model, sub)` rather than one per message:
  19,580 messages a day is 3,400 buckets, and the split that matters is the one
  the deck can't show — **38% of all calls on this machine came from Agent-tool
  subagents**, which is what `sub` (the transcript sitting under `subagents/`)
  records. What is kept from `usage` is chosen for what is *not recoverable
  later*: the 5m/1h cache-creation split, because those are billed differently,
  and `model`, for the same reason. An all-zero usage object — a `<synthetic>`
  message, an API error, an interrupt — earns no bucket; it was a third of the
  rows on the first backfill. `compactTokens` is not housekeeping: a pass
  appends a bucket for the hour in progress, so a 5-minute cadence writes a
  dozen rows for one hour, and merging them is what keeps the log growing with
  *time* rather than with the poll rate. The first pass reads the whole tree —
  11s against 2GB, measured — so `index.mjs` fires it without awaiting and
  guards it in-flight, the shape `remote-hosts.mjs` uses and for the same
  reason: the bookmark is written when a pass *finishes*.
  **It reads a second vendor's log, and that is what `provider` is for.** The
  ship-review skill drives `codex exec` for a second opinion, so part of the
  cost of a review lands in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
  nothing above could see it. Same file, same buckets, told apart by
  `provider`; a record written before the field existed is Claude's, which is
  why it defaults rather than being required. **`last_token_usage`, never
  `total_token_usage`** — Codex emits both on every turn and the total is
  *cumulative for the session*, so summing it counts every turn once per turn
  that follows: on this machine that inflated all-time output from 6.8M to
  79.6M, a factor of twelve, and nothing about the number would have looked
  wrong. The per-turn field sums to exactly the final total, verified against
  the longest session on disk. `cwd` and `model` live in the session header and
  in `turn_context`, which a byte cursor has usually already passed, so the
  head of the file is re-read for them rather than carried in the bookmark; and
  bookmarks are namespaced `codex/…` because both trees are keyed by a relative
  path into one map. Codex reports no cache-write counter and no ttl split, so
  those stay zero — absent, not zero-because-nothing-was-written.
  **What is still not captured is Claude billed to the API rather than the
  subscription.** Nothing in a transcript says which: no `costUSD`, no
  `apiKeySource`, and `service_tier` is `"standard"` on all of it. When that
  becomes findable it is another `provider` value, not another column — which
  is the whole reason the split is keyed that way rather than by a boolean.
