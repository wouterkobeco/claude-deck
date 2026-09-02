# Sessions: reading Claude Code's state

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/sessions.mjs` — the only reader of Claude Code's state, read through a
  *source*: `{ host, root, isAlive, tail }`. `getLiveSessions(sources =
  [localSource()])` runs the same body over every source and concatenates the
  result; `localSource(root?)` is today's behaviour with a name, so the
  default argument is the whole of what changed for a machine with no remote
  hosts. A remote host supplies nothing more than those three things — where
  its tree landed after `remote-fs.mjs` fetched it, membership in a pid list
  fetched alongside it instead of `process.kill`, and a tail read over ssh
  instead of a local file — because every path in this module already derives
  from one root (`CLAUDE_DIR`, or a source's `root`), so that's the entire
  host-dependent surface — everything between a source going in and sessions
  coming out (matching, enrichment, subagent synthesis) is the same code
  either way. It joins the
  session registry against open VS Code workspace folders (a session with no
  local window is dropped), then enriches with `aiTitle` (tail-scanned from the
  transcript jsonl), task progress, and context usage. Every file read is wrapped in try/catch
  that skips rather than throws: these files are written by another process and
  a poll can land mid-write — a source's `isAlive`/`tail` are someone else's
  code (an ssh-backed source can throw where a local read only fails), so
  `getLiveSessions` itself wraps each source's `sessionsFrom` call so one bad
  host drops only its own keys rather than the whole board. `readTranscriptSignals` reads `aiTitle` and two
  more things from that same tail scan — see the two invariants below. Context
  usage prefers the ctx file the status line writes and falls back to
  `contextPercent` over the newest assistant line's own `usage`, which the same
  scan already has in hand because the window depends on the model on that line;
  the table of windows and why it holds only measured ones is in statusline.md.
- **Nothing in a transcript line may be matched as a raw substring.** A
  transcript stores tool results verbatim, so a session that greps this repo or
  prints another transcript writes `<command-name>/clear</command-name>`,
  `toolDenialKind` and `"type":"user"` into its own tail *as text* — on
  `type:"user"` lines, because a tool result rides on the user turn. Every
  marker in `readTranscriptSignals` is therefore a cheap pre-filter only, and
  nothing is believed until that line's own parsed JSON says so: `type` from
  the top level, a command from `message.content` *starting* with its tag,
  `toolDenialKind` as a field. The `/compact` detection was written this way
  from the start; `/clear` and `blockedOnDenial` were not, and this project's
  own key spent a session reading CLEAR because of it.
- **`/clear` reuses the transcript file.** It's written as an ordinary line
  (`<command-name>/clear</command-name>`) into the same `.jsonl`, not a new
  file, so a naive backward scan for `aiTitle` would keep surfacing the
  pre-clear summary. `readTranscriptSignals` stops at the most recent `/clear`
  instead; if nothing's been said since, it reports `clearedEmpty: true` and
  `index.mjs` shows a body of `CLEAR` rather than falling back to the session
  name or cwd — those would look like a real answer when the honest one is
  "nothing yet". `renderKey` draws that word for any empty body, so the same
  key can't be blank in one place and named in another.
  **A session that was never typed into says the same thing**, reached the
  other way: `startedEmpty`. Claude Code writes a transcript the instant a
  session opens (a mode line, a snapshot, any SessionStart hook output — all
  `type:"attachment"`), so the file's existence proves nothing; the first
  `type:"user"` line is the human's first prompt. That absence only counts
  when `tailLines` reports `whole` — its window reached byte 0 — because "no
  user line in the last 64KB" is equally true of a long session mid tool-call
  stretch. Every other signal in that scan stops at its first hit going
  backwards, which a tail can only help; this is the one that has to know it
  saw the whole file.
  **Those two flags are the only things allowed to blank a body, and nothing
  below them may fill it.** The rungs under `aiTitle` all describe the session
  rather than the conversation — `lastPrompt`, then a name Claude Code derived
  from the cwd (`kob-portal2-01`), then the cwd — so `keyFields` reads as one
  chain, but the two directions of error are not symmetrical: a session nobody
  has spoken to *must* read CLEAR, and a session that is **working** must never
  read it. Both halves have now been wrong on this machine's own deck within one
  day, in opposite directions, from the same edit.
  **`lastPrompt` is the rung that carries the early session**: `aiTitle` doesn't
  exist for the first turn or two, and roughly one session in sixteen here never
  gets one at all (measured: 41 of 693 transcripts in one project), so without
  it a key spends that time showing a placeholder derived from the folder it is
  already captioned with. It's the newest thing the *human* typed, off the same
  tail scan, and almost no `type:"user"` line qualifies: a tool result rides on
  the user turn (content is an array of blocks), and Claude Code injects its own
  — skill bodies, command output, the local-command caveat — marked `isMeta`.
  **`isMeta` doesn't catch all of them**: a `<task-notification>` for a finished
  background agent is an unflagged string user line of pure markup, and it drew
  its own tags on a live key, so anything opening with a tag that isn't a
  command is treated as Claude Code talking to itself. That rejection has to
  leave the search *unresolved* rather than answer null — otherwise one
  notification hides the prompt sitting right behind it. A slash
  command is stored as its own markup and is unwrapped to the command (plus its
  args), because the tags would fill the key with angle brackets; `/clear` needs
  no case of its own, since it *is* one of these lines and so stops the search
  before it can reach the conversation that was thrown away.
  **What it cannot do is reach past the tail.** A session that has been working
  for twenty minutes has pushed its prompt out of the last 64KB, and if it also
  never got an `aiTitle` its key falls all the way back to the derived name —
  the one case this rung was added for that it does not fix. The prompt is at
  the *head* of the file, and a source's contract is `tail`; reaching it means
  either a local-only read (breaking "the same code either way") or heads in
  `remote-fs.mjs`'s second call, whose framing has already been got wrong once.
  Left undone deliberately.
- **"idle" can mean "asked you for permission and is waiting."** Claude
  Code's session `status` reports a turn that ends right after an auto-mode
  permission denial exactly the same as any other completed turn: `idle`.
  `readTranscriptSignals`'s `blockedOnDenial` catches the one case that
  matters — the newest `type:"user"` line in the tail is a denied tool result
  with no human reply after it — and `getLiveSessions()` promotes that session
  to `requires_action`. It's a narrow signal, not certainty (an assistant that
  quietly recovers and keeps working would also match, briefly); good enough
  for a key that needs to catch your eye, not a guarantee.
- **A session that reports no `status` is not idle.** An SDK session's
  registry entry has no `status`, `updatedAt` or `statusUpdatedAt` at all,
  where a `cli` one has all three — so `s.status ?? "idle"` called one idle
  while it was mid-turn, and its marker on the project key sat grey. Measured:
  an `sdk-py` security reviewer, alive 2m30s, sampled 17 seconds after its
  last transcript write, reporting no status of any kind. `matched`
  therefore carries `null` for a missing status (absent and idle have to stay
  distinguishable until enrichment can tell them apart) and `liveState`
  answers it from the transcript: `end_turn` is finished, anything else — a
  tool call outstanding, or a newest line that is the user's, meaning the model
  is answering right now — is work in flight. That is `readRunningSubagents`'
  rule on the same evidence, minus its idle-age cap: a subagent has no pid to
  check, so an interrupted one would hang busy forever, while everything in
  the registry has already passed `isAlive`. Note what this is *not*: a
  silence heuristic. Nothing here is inferred from a gap in time.
- `src/sdd-ledger.mjs` — tasks Claude Code doesn't know about. The progress
  bar and the detail board both come from `~/.claude/tasks/<session id>/`,
  which is filled only when a session uses Claude Code's *own* task tool — a
  session driving superpowers' subagent-driven development instead keeps six
  tasks in a ledger inside the project, dispatches an implementer subagent per
  task, and narrates the rest. Measured: that session showed a blank progress
  bar and an empty detail board through a day of work, and every
  `~/.claude/tasks/<id>/` on this machine holds nothing but a `.lock` and a
  `.highwatermark`. **This is the first thing the daemon reads outside
  `~/.claude` and VS Code's storage** — the read-only invariant is about the
  four files it *writes*, none of which are here, but it is a new direction and
  gets its own file for that reason. It returns the *same shape*
  `~/.claude/tasks` produces (`{subject, status}`), so `taskCounter`,
  `taskWindow`, the bar and the detail tiles all work on it unchanged and there
  is one task list in this project rather than two.
  **It parses another tool's file, and only the two parts that tool depends on
  itself**: `scripts/sdd-workspace` fixes the directory at
  `<repo root>/.superpowers/sdd/<plan basename>/`, and SKILL.md's own recovery
  rule is "tasks with a `Task <N>: complete` line are DONE — resume at the
  first task without one". A controller that misreads either re-runs finished
  work, so they are as stable as another tool's format gets; the prose and the
  fix-round lines between them are deliberately not read. Titles come from the
  `task-<N>-brief.md` filenames, so a cleaned-up workspace still counts and
  just reads "Task 3". Two guards earn their place: the `# SDD ledger` identity
  line the skill mandates, without which this is somebody else's progress.md,
  and a 24h mtime cap — a finished plan deletes its own workspace, so an
  abandoned one would otherwise show "3 of 6" on a key forever.
  **The fallback lives in `readTaskList`**, the one function the bar and the
  detail board already both route through, so neither can have it without the
  other; Claude Code's own tasks win whenever there are any.

  **A controller's plan is not at or above its cwd, and that is why
  `readLedgerTasks` takes candidates.** `findWorkspace` only ever walks up, and
  superpowers' SDD runs from the repo root with the workspace a level *down*,
  inside `.claude/worktrees/<name>/` — so the session that owns the plan is
  exactly the one that cannot find it. Measured: a controller eight tasks into
  nine, key blank the whole way, while its dispatched agents (standing inside
  the workspace) each carried the count they had borrowed from it. The second
  candidate is the cwd of a subagent this session is *running*, which
  `readRunningSubagents` now reads off the same tail scan as `stop_reason`.

  **Only its own agent's, and this is the whole of the attribution
  argument.** Eight live sessions sat at that repo root; a plan found by
  scanning the tree downward would have painted the same "8 of 9" on all
  eight, which is the misattribution `nestedFor` was written to stop for
  colour. A child may speak for its parent because `parent` is recorded at
  synthesis; a sibling may not, and `agentCwds` is where that is enforced. An
  agent's cwd equal to its parent's is dropped — it was already tried first.

  **Both kinds of child count, and that needed a pid.** SDD alternates: an
  Agent-tool subagent implements a task, an *SDK session* reviews it. The
  first carries a `parent`; the second records none, so the controller's key
  found the plan for one phase and lost it for the next. `attachSdkParents`
  closes that by walking the pid ancestry — the Agent SDK spawns `claude` as a
  subprocess, so the session that started it is up the chain. Caught live
  here: `worker -> python3 -> the controller's own claude pid`. It runs only
  when there is a parentless nested session to place, so a machine without one
  never pays for `ps`, and a remote source uses the host's own table
  (`source.ppids`) because local pids mean nothing over there. Note the
  knock-on: `parent` alone no longer means "Agent-tool subagent", so the
  synthesised ones carry `subagent: true` and the web panel's token lookup
  keys off *that* — an SDK session has a transcript of its own, not one under
  its parent's slug.

  **And a session alone between dispatches keeps its plan.** `workspaceMemory`
  is the one thing this module remembers between polls: the last cwd a
  session's own agent worked in, held for the life of that session
  (`getLiveSessions` prunes, because only there is the whole live set in
  hand). Without it the count blinks off every time the controller sits alone
  writing the next brief, which reads as a broken board. It is a hint, never
  an answer — the ledger at that path is re-read every poll, still has to
  parse, still has to be an SDD ledger, and the 24h staleness cap still
  decides whether it is progress or an abandoned plan. It is the one
  reader that is **local-only** — `readLedgerTasks(cwd)` needs a path on *this*
  machine and `remote-fs.mjs` fetches `~/.claude` and nothing else, so both
  call sites pass null for a remote session rather than reading a stranger's
  directory.
- **Nested means spawned by another session, not "in a subdirectory".**
  `sessions.mjs` sets `nested: true` from `entrypoint`: `sdk-py`/`sdk-ts` is an
  agent some script started, `cli` is one you started yourself.

  **An Agent-tool subagent isn't in the registry at all** — background or not,
  it runs inside its parent's process, so `entrypoint` never sees it and
  "Waiting for 1 background agent to finish" showed nothing on the deck. It
  exists on disk only as `projects/<slug>/<parent id>/subagents/agent-*.jsonl`
  with a sibling `.meta.json` (the Agent call's own `description`), and
  `readRunningSubagents` synthesises one nested pseudo-session per *running*
  one — no registry entry, so no `state` either: a running agent is busy by
  definition, and its parent's folder is its folder. Running is the newest
  `stop_reason` in that transcript, which is exact rather than a guess:
  "tool_use" is an agent waiting on a tool, "end_turn" is one that has handed
  its result back and will write nothing more. Two cases never write an
  ending — an agent spawned seconds ago and an agent interrupted mid-tool —
  and both are settled by mtime: no ending plus a fresh file is running,
  `SUBAGENT_IDLE_MAX_S` (10 min) quiet retires it. Don't reach for the parent
  transcript's `tool_result` instead: a backgrounded agent's result lands the
  moment it's *spawned*, so it says nothing about whether it's done.

  `assignSlots`
  keeps nested ones off the board's slots; they attach to a key as a small
  square coloured by their own state, and become readable tiles in three places
  — the attention queue if they block, the detail board they attach to, pinned
  to its tail, and the web panel's subagent row.

  **A nested session's progress belongs on those tiles.** Having no key means
  a nested session has nowhere else to put a count: the deck's detail tile has
  always passed `progress` to `renderKey`, but the web panel's row carried only
  name, tokens and state, so on that page a session showing 6 of 9 read as a
  dot. Measured, on the day it happened: `getLiveSessions` had
  `{ current: 6, total: 9 }` in hand and every surface but one dropped it. The
  row now carries `done/total` and the active task's subject. The key's own
  square stays a *marker* — a coloured dot cannot hold nine tasks, and the key
  belongs to the session it names.

  **Whose plan that is deserves care.** In the case measured, it was not the
  SDK session's own: superpowers' SDD controller is an ordinary `cli` session
  that dispatches a *fresh* SDK session per task and per review, each living
  minutes, and those run inside the worktree that holds the plan workspace —
  so `readLedgerTasks` walks up from their cwd and hands each of them the
  controller's ledger. The count on such a row is the plan the session is
  working *on*, which is the useful reading, but it is not a plan that session
  is driving. The controller itself, whose cwd is the repo root while the
  workspace is a level down in `.claude/worktrees/<name>/`, gets nothing:
  `findWorkspace` only ever walks up.

  **Which key is `nestedFor`, and it goes by parent, not folder.** An
  Agent-tool subagent carries the `parent` its synthesis in `sessions.mjs`
  recorded, so it lands on the key of the session that actually spawned it —
  and since `refresh` colours a key `mostUrgent([own, ...nested])`, that is the
  difference between a busy agent tinting its own key and tinting a *sibling's*.
  Folder-attachment shipped first and got this wrong: with three sessions open
  in one repo, the greened key was whichever came first in the block, which
  after a daemon restart is `readdir` order of `~/.claude/sessions` and means
  nothing — an idle session that had just finished sat green for an agent two
  keys over. An SDK session has no key of its own to point at and so carries no
  `parent`; it keeps the old behaviour, folding onto the block's first key,
  which is what the `primary` argument is for. `refreshDetail` calls the same
  helper so a tile and a marker can never disagree about whose agent it is.

  **This used to be inferred from the cwd**, and that was wrong. Anything below
  the window's folder was called nested, which caught the SDK helpers *and*
  every worktree — and most work in this setup happens in worktrees, so full
  agents were being hidden behind a marker built for background helpers. A cli
  session now gets a key wherever its cwd sits. The machinery that existed only
  to paper over the old rule is gone with it: `everReal` (which rescued a
  session that ran `EnterWorktree` mid-task) and orphan promotion (which
  rescued a folder whose only session had wandered into a worktree). A folder
  whose only sessions are nested now shows nothing, which is right — a key for
  one is exactly the phantom that once appeared for a security review nobody
  opened.
- **"compacting" means the newest user line is a `/compact` command, or a
  fresh PreCompact/PostCompact marker exists.** A manual `/compact` writes its
  command line into the transcript the moment it starts (bare `"/compact"`
  content or the `<command-name>` form — match the parsed content exactly,
  never the raw line, which tool results can contain), then writes nothing
  until the finished `compact_boundary` — so that line *is* the start marker,
  observed directly. The session must also say `busy` (clears the spinner the
  instant a `/compact` is canceled) and the marker must be younger than
  `COMPACT_MAX_S` (clears leftovers `busy` can't). `compactingNow` is this
  whole rule, exported and pure for the same reason `statusKey` is.
  **The registry has no compaction field, the status-line payload has none, and
  an auto-triggered compaction writes no start marker anywhere in the
  transcript** — checked directly against a real one (every `type:"system"`
  subtype present: `away_summary`, `local_command`, `stop_hook_summary`,
  `turn_duration`, `compact_boundary`; nothing announces the start).
  **Don't reintroduce the silence heuristic** ("busy + no pending tool +
  transcript quiet for 25s"): a turn thinking without a tool call is exactly
  as silent, so it false-fired on every long reasoning stretch. That shipped,
  and was replaced by the marker — which is why an auto-triggered compaction
  was, for a while, genuinely undetectable rather than merely unheuristic.
  **`readCompactMarker` is the second signal, fed by compact-hook.mjs's
  `PreCompact`/`PostCompact` hooks** (see statusline.md) — the one place an
  auto-triggered compaction is observable while it's still running, on a
  machine that has the (optional) hooks installed. It reads
  `~/.claude/streamdeck-compact/<id>.json`, written the instant `PreCompact`
  fires and removed by `PostCompact`, and `compactingNow` trusts it on its
  own — no `busy` requirement, because the hook already brackets the
  compaction precisely — capped at `MARKER_MAX_S` (600s) only as a safety net
  for a `PostCompact` that never fires. Without the hooks installed, `marker`
  is always null and this is exactly the manual-only rule above, unchanged.
  `renderCompacting` draws a sweeping ring rather than a percentage, because
  no progress figure exists to draw — `pulse()` advances its phase a twelfth
  per tick and, as everywhere, never writes `btn.drawn`.
