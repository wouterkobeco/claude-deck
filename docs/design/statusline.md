# The manual install steps (context gauge, compaction hooks)

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/statusline.mjs` — the context gauge's one install step, as a pure
  decision: the block, the whole minimal script, `insertBlock` and `decide`.
  Nothing here writes; the two things that do are commands
  (`scripts/statusline-prompt.mjs` for this machine, `scripts/remote-install.mjs`
  for a host), which is what keeps `statusline-check` able to run it. See the
  status-line invariant below for what the five answers mean and why `manual`
  is one of them.
- **One install step, in the status line, and `npm start` now offers it.**
  Context usage is the exception to the above: Claude Code hands a session's
  context percentage to the status line and nowhere else, so
  `~/.claude/statusline-command.sh` writes it to
  `~/.claude/ctx/<session id>.json` for the daemon to read. That block is
  quoted in `README.md`. If a machine has no status line, or the block is
  dropped, the gauge falls back to the transcript and is never an error.
- **The transcript is the fallback, the ctx file is the authority.** An
  assistant line's `message.usage` describes the whole prompt behind it, so
  `cache_read + cache_creation + input` is the context in the window at that
  moment — `contextPercent` in `sessions.mjs` divides it by the window for the
  model on that same line, and reproduces Claude Code's own percentage exactly,
  rounding included, against the ctx files on this machine. That is a change of
  fact, not of taste: this doc used to say the transcript can't answer this
  because it doesn't record the window size. It doesn't — but it records the
  *model*, and a window can be measured (prompt size ÷ the status line's own
  percentage, over dozens of live sessions) rather than guessed. So
  `CONTEXT_WINDOWS` holds only measured models and a model outside it draws no
  gauge at all; a bar reading 40% on a session at 8% is worse than no bar.
  (claude-deck, which is where the idea came from, ships a guessed table —
  its `claude-fable-5: 200_000` measures 1M here across 21 sessions.) Measured
  means measured: opus-5 (n=273), sonnet-5 (n=72) and fable-5 (n=21) are in the
  table because every ctx file on this machine was divided into its transcript's
  prompt size; `claude-opus-4-7` and `claude-sonnet-4-6` appear in transcripts
  here and are still absent, because no ctx file survives for either. Adding one
  is a measurement, never a name you reasoned about — Claude Code's own
  changelog carries a fixed bug where it offered a 1M upgrade to a model that
  already had a 1M window. The status line still wins
  wherever it is installed: it is measured against the window Claude Code
  actually has, so it survives a model we have never seen and a 1M beta flag
  flipping under a model we have.
  **It was the one part of setup that could only be done by hand**, and its
  failure mode is silence: no ctx file looks exactly like a healthy machine
  mid-first-turn — which is what the fallback above softens, not removes. `scripts/statusline-prompt.mjs` is the second `prestart`,
  beside `ext-prompt.mjs` and with the same contract — silent when there is
  nothing to do, one line when there is nobody to ask, every path exits 0.
  **The decision is pure and lives in `src/statusline.mjs`** (`decide`,
  `insertBlock`, `CTX_BLOCK`, `MINIMAL`) for the reason `applyAccentChoice`
  does: the script around it writes the real `~/.claude`, so a check that drove
  *that* would edit whatever status line this machine happens to have.
  `statusline-check` drives the pure half against fixtures and then runs
  `MINIMAL` under a real `bash` — it is shell, and a template literal that
  looks like shell is not the same as one that parses.
  Its five answers are the whole feature: `ok` (silent), `nojq`, `install`
  (the only one that touches `settings.json`), `append`, `manual`. **`manual`
  is not a failure path**, it is the refusal `remote:install` already makes —
  a status line is read on every turn, and a `statusLine` key pointing at
  something else, or a script that reads stdin some other way, is described
  rather than guessed at. The block goes *after* `input=$(cat)` rather than
  appended, because it reads `$input` and a script ending in an `exit` would
  swallow it silently; `insertBlock` returning null **is** the test for
  "appendable", so `decide` calls it rather than matching the anchor twice.
  `MINIMAL` is shared with `remote-install.mjs` rather than copied — two
  versions of a shell block is two things to keep in step, and only one of them
  would ever be the one that was tested.
  **A remote host needs the same step, and `npm run remote:install -- <host>` is
  the only thing here that writes to another machine.** It is a command you run,
  never `postinstall` — `npm install` reaching across ssh to edit a config is
  not a trade this project makes — and it refuses rather than overwrites: a host
  with an existing status line, or an existing `statusLine` key, is left alone
  and told what to add by hand. A status line is read on every turn, and
  replacing one to feed a gauge on a key is not a fair trade.
  **"Exists" there means `-s`, not `-e`** — a zero-byte file is a placeholder, a
  truncated write or a `touch`, not something anyone wrote, and refusing to
  install over it protects nothing while blocking the only command that fixes
  it. That is not hypothetical: an empty executable appeared on a host that had
  none, with no `statusLine` key even referencing it, and the install refused
  itself out of a file with nothing in it. The probe takes its directory from
  `$CLAUDE_DIR` so `remote-install-check` can run it under a real shell against
  fixtures — the decision is shell semantics, and a check asserting the command
  *string* would have passed happily while `-e` was wrong.
  **The gauge's file is fetched through call 2's path list, not the tar.**
  `ctx/` accumulates one file per session a host has ever run and tar spends a
  512-byte header on each: measured, 118 files holding 1,775 bytes of content
  tarred to 360KB, against a whole tree of 20KB. Asking for exactly the live
  sessions' files costs a few hundred bytes and no extra round trip. Filtering
  the tar by mtime was the alternative and is worse — a session can sit idle for
  days with a perfectly good context file, which is precisely what "a stale file
  is fine" above means.
  **A remote session id is not this machine's data, and it reaches a path.**
  It comes out of the other host's registry, so a compromised — or simply
  hostile — box chooses it, and opening a Remote-SSH window is not a statement
  of trust in that box's filesystem. `join(root, "ctx", id + ".json")` collapses
  `../`, so an id like `../../../../tmp/x` escapes the scratch tree and the
  bytes written there come from the same host: an arbitrary file write, on this
  machine. The same string also goes over stdin as a path the host reads, so
  traversal there reads a file outside `~/.claude` and streams it back.
  `isPathSafeId` refuses rather than sanitises — a real session id is a UUID, so
  a slash or a `..` in one has no legitimate reading, and rewriting an
  attacker's string into a "safe" one is how the next bug gets built. Everything
  else derived from remote data was already safe: `projectDirFor` flattens a cwd
  through `[^a-zA-Z0-9] -> -`, and tar refuses absolute and `..` members. This
  was the first place remote data reached a path that gets *written*, which is
  the thing to watch for when adding the next one.

## The compaction hooks (auto-triggered compaction)

- `src/compact-hook.mjs` — the second manual install step, same split as the
  status line: a pure `decide`, the hook script (`HOOK_SCRIPT`), and
  `withHooksInstalled`, the settings.json merge. Two commands write it —
  `scripts/compact-hook-prestart.mjs` (this machine, offered at `npm start`)
  and `scripts/remote-install.mjs` (a host) — nothing here does.
- **Why this exists at all: a manual `/compact` writes its own command line
  into the transcript the instant it starts (see the compacting invariant in
  sessions.md), an auto-triggered one writes *nothing* until it's already
  over.** Checked directly against a real one on this project's own Pi: every
  `type:"system"` subtype in a transcript spanning an auto-compaction —
  `away_summary`, `local_command`, `stop_hook_summary`, `turn_duration`,
  `compact_boundary` — and none of them announces the start. `compact_boundary`
  itself now carries `compactMetadata.trigger` ("auto"/"manual") and
  `durationMs`, which is how the 160s figure below was measured, but it lands
  *after* compaction ends — too late for a live key. Claude Code's
  `PreCompact`/`PostCompact` hooks are the only place that moment is
  observable, verified against Claude Code's own hooks reference: both fire
  for either trigger, with a `matcher` that can tell them apart (this hook
  doesn't bother — it does the same thing either way).
- **Unlike the status line, there is nothing here to refuse.** `statusLine` is
  one slot in `settings.json` one command owns, so installing over someone
  else's is a real conflict `decide`'s `manual`/`append` branches exist to
  avoid. `hooks.PreCompact`/`hooks.PostCompact` are arrays every hook gets its
  own entry in, so this only ever *adds* one — `withHooksInstalled` is
  additive and idempotent, `decide` only ever answers `ok` or `install`, and
  `remote:install`'s half runs unconditionally, independent of whatever the
  status line install below it decides.
- **Grep+sed, not jq.** The status line block needs jq because its payload is
  nested (`context_window.used_percentage`); this hook only ever reads two
  flat top-level strings (`session_id`, `hook_event_name`), which a `grep -o
  '"key"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/'` pair
  gets cleanly with no new dependency for `decide` to gate on. `printf '%s'`
  rather than `echo`, so a session id that happened to start with `-` can't be
  read as a flag.
- **The marker's lifecycle is the hook's own write/delete, not a TTL the
  daemon enforces as the primary signal.** `PreCompact` writes
  `~/.claude/streamdeck-compact/<id>.json` (`{at: <ms>}`); `PostCompact`
  removes it. `compactingNow` in sessions.mjs (see sessions.md) still caps a
  marker's age at `MARKER_MAX_S` (600s) as a safety net for a `PostCompact`
  that never fires — an interrupted compaction, a crash — sized off the hook's
  own default 10-minute timeout rather than the manual path's `COMPACT_MAX_S`
  (180s): a real auto-compaction on this machine measured 160s, already past
  the "70-120s" the manual path was timed at, so reusing the tighter cap would
  have clipped a real one.
- **A `PreCompact` hook can delay the compaction it's reporting on** — Claude
  Code runs it *before* compacting, with a 10-minute default timeout, so a
  slow hook stalls the thing it exists to make visible. The script here is a
  file write and nothing else, on purpose.
- **A remote host needs the marker fetched the same way `ctx/` is** —
  `compactTargets`/`writeCompactFiles` in remote-fs.mjs mirror
  `ctxTargets`/`writeCtxFiles` exactly, including the shared `isPathSafeId`
  guard, with one deliberate difference: a context file's "stale is fine"
  contract doesn't hold for a marker, so a remote file that's gone missing
  (PostCompact) has to *delete* the local cached copy, not just leave it —
  otherwise a finished compaction would keep reading as running until the
  next full restart of that cache.
- **`remote-install.mjs`'s half never touches jq.** It fetches the remote
  script and `settings.json` as plain text in one round trip (NUL-delimited,
  the same framing reason `TAILS_CMD` uses it), runs them through the exact
  same `decide`/`withHooksInstalled` the local prestart calls, and writes the
  result back — one copy of the merge logic instead of a second one
  hand-rolled in jq, and the write-back already needs the round trip either
  way.

## `npm start` checks remote hosts too (`remote-prestart.mjs`)

- **`remote-install.mjs` is split into probe and apply, one pair per feature**
  (`probeCompactHook`/`applyCompactHook`, `probeStatusLine`/`applyStatusLine`),
  so both the manual `npm run remote:install -- <host>` command and
  `scripts/remote-prestart.mjs` call the *same* functions instead of the
  prestart re-deriving what the CLI already knew how to decide. The split
  exists because the two callers need the decision and the write at different
  times: the CLI does both back to back with no question asked (running the
  command *is* the consent), while the prestart has to probe several hosts up
  front, then ask — one at a time, since a terminal can't take two answers at
  once — only for the ones that need something.
- **Probing has to be fast and forgiving, in a way the CLI's own probe never
  had to be.** `npm start` runs on every launch, and this project's own
  remote host is home-automation gear that's routinely off — a 30s ssh
  timeout on the critical path of *every* startup would make the daemon learn
  to dread its own remote host. `PROBE_TIMEOUT_MS` (5s) overrides the CLI's
  default per call, and every host is probed with `Promise.all` rather than
  in sequence: an unreachable host must not delay a reachable one, and this
  whole phase is read-only, so there is nothing that needs serialising.
  Anything that fails the probe — timeout, refused connection, an ssh error —
  is caught into the same `"unreachable"` shape actions never match, so it
  falls through every branch silently, the same as an unreachable host reads
  everywhere else in this project (grey, not red).
- **The two features' `"leave alone"` outcomes are not the same shape, on
  purpose.** The compaction hooks have exactly one: `"ok"` (already wired).
  The status line has three — `"has-script"`, `"has-key"`, `"ok"` — because
  the CLI needs to say *which* thing it found to refuse accurately
  (`~/.claude/statusline-command.sh already has content` vs `settings.json
  already sets statusLine`), where the prestart doesn't care which and
  folds all three into "nothing to offer." Collapsing them at the source
  would have cost the CLI its accurate refusal message; keeping them apart
  costs the prestart nothing, since it never branches on which one it got.
- **The controlPath now carries the host, not just the pid.** The original,
  single-host script hardcoded `streamdeck-install-<pid>` because there was
  only ever one host per process. Probing several hosts from one process at
  once meant two different hosts' control masters could bind the same
  socket — `ssh(host, …)` now builds `streamdeck-install-<pid>-<host>`, one
  socket per host per process, the same reason the daemon's own fetch uses
  ssh's `%h` for a shared argv reused across hosts (this doesn't: the host is
  already known in JS at call time, so it's substituted directly rather than
  left for ssh to fill in).
- **No new persisted file.** Every `npm start` re-probes every open remote
  host from scratch — a deliberate choice over caching a verdict, since the
  common case (already installed) answers in one fast round trip over a warm
  connection, and a cache would mean a host that later lost its hooks (a
  `settings.json` reset, say) silently stops being offered them again.
- Verified end to end against this project's own Pi: hooks removed, probed
  (correctly detected and, non-interactively, printed the manual command
  rather than guessing), reinstalled with `--yes`, diffed byte-for-byte
  against a backup taken before the test to confirm nothing else in
  `settings.json` moved, then re-probed once more to confirm silence once
  everything is already in place.
