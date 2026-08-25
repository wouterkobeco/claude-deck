# Remote hosts

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/remote-fs.mjs` — fetches one remote host's small files and transcript
  tails over `ssh`, assuming nothing on the other end but a POSIX shell: no
  collector script, no interpreter, because `sessions.mjs` already computes
  every path it needs from the registry it fetches first (an earlier draft of
  this spec shipped a Python collector before that was noticed). Two calls.
  `TREE_CMD` tars `sessions/`, `ide/`, `tasks/` and every non-transcript file
  under `projects/`, with the member list built by piping `find` through an
  anchored BRE rather than `tar --exclude`: `--exclude` matches with `fnmatch`
  and no `FNM_PATHNAME`, so `*` crosses `/` — a `projects/*/*.jsonl` exclude
  also drops the depth-four subagent transcripts, and the only symptom is that
  no remote session ever shows a subagent. Measured against a real host: 20KB
  fetched with the anchored list, 4.7MB without. `TAILS_CMD` reads exactly the
  transcripts `sessions.mjs`'s own path functions ask for, NUL-delimited with
  no length prefix — an earlier version sent `wc -c` then `tail -c`, two reads
  of a live file, so a sub-64KB transcript that grows between them made the
  reader take the surplus as the next file's opening bytes; `whole` now comes
  from the bytes actually received, not a separate count. `swapTree` extracts
  into a scratch directory and renames it over the previous one rather than
  letting `tar -xf` merge: a merged tree keeps what the remote deleted, so a
  closed window's `ide/*.lock` would linger and keep `matchFolder` matching a
  folder with no window — the exact invariant the whole join exists to
  enforce.
- `src/remote-hosts.mjs` — which hosts are due for a fetch this tick, and what
  to hand the board for the rest: `dueHosts`, `remoteSources`,
  `cachedSources`. Remote hosts poll slower than local — `REMOTE_POLL_MS` (6s
  against the daemon's 2s) — because two ssh round trips every 2s plus a held
  `ControlPersist` connection is a constant background load on a machine doing
  its own work, here a Raspberry Pi running home automation; nothing on a
  remote key changes faster than it can be read, so the slower cadence costs
  nothing visible. Consecutive failures back off 5s → 10s → 30s and one
  success resets, the shape `usage.mjs` already uses for 429s.
  `STREAMDECK_NO_REMOTE=1` skips every remote source — every other risky
  reader here degrades to nothing by itself, and this is the one holding an
  open connection to another machine, so it gets an explicit off switch.
  **A failing host used to vanish silently**, and that was the one dishonest
  thing on the board: a failed fetch leaves `source: null`, `cachedSources`
  filters it out, and its keys disappear exactly the way a closed window's do.
  `unreachableHosts` says so instead, and what makes that possible is that a
  remote window's extension host runs *locally* (`extensionKind: ["ui"]`), so
  `readWindowStates()` still knows that host's windows and folders while ssh is
  dead — the information was always there and was being discarded. It reports
  one entry per *folder*, so each stand-in key lands in the block slot its
  project already held, and it keys them so a folder open in two windows on one
  host is one key rather than two on the same slot. It tests `failures`, not
  `source == null`: a host never fetched also has no source, and "not yet" is
  not "unreachable". `failingSince` is stamped once at the transition into
  failure and cleared on success — `lastAt` would answer "how long since the
  last retry", which is always about zero and says nothing.
  **`cachedSources` is what the poll loop actually reads, every 2s — no fetch,
  no await.** A fetch is two *sequential* ssh calls, each bounded by its own
  15s hard kill, so awaiting one inline stalls a tick by up to ~30s — pausing
  every key's redraw, local ones included, because one other machine went
  quiet. A bounded stall is still a stall; `remoteSources` starts the fetch and
  the poll draws whatever the last one produced, at the cost of one poll of
  staleness the first time a remote window appears. Freshness, never frames.
  **The in-flight guard is load-bearing, not hygiene**: `lastAt` is stamped
  when a fetch *finishes*, so without an explicit in-flight claim a slow fetch
  stays "due" for its whole duration and the next tick would start a second
  one against the same staging directory and ControlPath; eviction likewise
  skips an in-flight entry, or a window closing and reopening mid-fetch — a
  reload, which this project treats as routine — would strip the guard out
  from under a fetch that is still running.
- **A key whose host went away says so; it does not disappear.** `refresh`
  synthesises one stand-in "session" per unreachable folder
  (`unreachableTiles`) and passes it to `assignSlots` **there and nowhere
  else** — deliberately not through `liveSessions()`. It must not reach
  `publishSessions` (the restore command would try to `claude --resume` an id
  nothing can resume), `liveProjects` (the config page would list a project
  that isn't running), or `attentionQueue` (nothing here is blocked on you).
  It carries the real folder and host, which is exactly what earns it the
  block's own slot and accent: `folderKeyFor` and `folderOrder` treat it as the
  missing sessions were treated, so the key appears where it always was. Drawn
  grey rather than red — `CLAUDE.md` reserves the pulse for things blocked on
  you — which means the *word* on the key is what tells it apart from an idle
  session, and that word is `offline` rather than the accurate `unreachable`
  because `renderKey` fills lines by character and eleven letters broke as
  "pi unreac / hable 4m" on the raster. `renderParams` is nulled on that
  branch, like every other board that isn't the session view, so `pulse()`
  never redraws a key this branch owns from stale data.
