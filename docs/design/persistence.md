# What the daemon writes: published sessions, accents, transfer

Part of the design record CLAUDE.md indexes. Moved here verbatim so it loads when this working set is being changed, not on every turn. Same rules as CLAUDE.md: new design notes for these files go here. A cross-reference like "see the read-only invariant below" may point at a sibling doc — CLAUDE.md's index maps which doc holds what.

- `src/publish-sessions.mjs` — the daemon's second write, and the only one that
  isn't a key press: `~/.claude/streamdeck-sessions.json`, the live session list
  (id, cwd, folder, host, title) for the extension's "restore my sessions"
  command to remember while the window is still open. **Claude Code removes its
  own registry entry on exit**, so after VS Code has been quit there is nothing
  left on disk saying what was running — measured on this machine, every entry
  in `~/.claude/sessions` belongs to a live process and there are no corpses to
  read. The snapshot therefore has to be taken while the sessions are alive, and
  it has to come from here rather than the window reading `~/.claude/sessions`
  itself, for two reasons the extension cannot solve: a remote window's sessions
  live on the other machine and only `remote-fs.mjs` has fetched them, and
  attaching a session to a window is `matchFolder` plus the IDE locks — a join
  `getLiveSessions()` has already done by the time anything is drawn. Nested
  sessions are excluded: an Agent-tool subagent has no session of its own to
  resume and an SDK one was started by a script, so restoring either restores
  something nobody opened. Published through `liveSessions()` in `index.mjs`,
  which wraps every `getLiveSessions` call site, so the file is written on every
  poll rather than only on the polls of whichever board happens to be up.
  **It has a second reader, and it is the next run of this daemon**
  (`readPublishedIds`). The rows are already exactly the non-nested sessions,
  which is exactly the set `sessionOrder` is over, so seeding first-seen order
  across a restart needed a *use* for this file rather than another one — see
  the ordering invariant below for why that mattered. The only change it forced
  is that `liveSessions()` publishes in **board order** now; the order was
  arbitrary before and nothing read it, and the extension still just filters
  the list to its own folders. A session this poll has never slotted
  (`assignSlots` runs only on sessions-board polls) sorts last in whatever
  order it arrived, which is what it would have got anyway. Ids are re-checked
  as strings on the way back in, the same rule `readAccents` applies to a
  colour: they become map keys and then reach `claude --resume` through the
  extension.
- `src/session-transfer.mjs` — moving a session to **another machine**, with
  its whole history, as two commands you run (`sessions:save`,
  `sessions:restore`). Where `publish-sessions.mjs` remembers what to reopen
  *here*, this carries it somewhere else.
  **A session is one file**: `~/.claude/projects/<slug>/<id>.jsonl`, the slug
  being its cwd with every non-alphanumeric replaced by a dash. Nothing else
  is needed to resume one — no registry entry (those are live-process only),
  no config. Measured end to end before any of this was written: a transcript
  whose id and cwd were rewritten, dropped into the matching slug on a path
  that had never seen it, resumed with its conversation intact.
  **The slug must match the destination cwd**, and that is the whole
  cross-machine problem. The same transcript under a non-matching slug answers
  `No conversation found with session ID` — tested — so `projectSlug` is
  exported from `sessions.mjs` and imported here rather than re-derived, since
  two copies of that rule drifting apart files sessions where resume will not
  look. `remapCwd` is prefix substitution, not replacement: a worktree
  session's cwd sits *under* its window's folder, and a wholesale swap would
  collapse every worktree onto the project's own slug.
  **Every restore mints a fresh id.** A bundle usually comes from a machine
  that still has the original, and two machines appending divergent histories
  under one id has no good ending. The cost is honest and worth stating: what
  you get is a copy that resumes, not the same session in two places.
  **What does not survive**, deliberately: `file-history-delta`,
  `file-history-snapshot` and `frame-link` records carry absolute paths into
  scratch and backup directories the other machine has not got. Rewriting them
  would invent files, so they travel unchanged — the conversation resumes and
  only undo/file-history is poorer for it.
  Subagent transcripts ride along (under the new id, with their `.meta.json`
  sidecars, which is what carries an agent's description) and so does the
  project's `memory/` — but a restore **never overwrites memory this machine
  already has**: a note written here is this machine's own, and only files that
  don't exist yet are written, with the rest reported rather than silently
  skipped.
  **A remote host's sessions save too**, and the fetch is the interesting part.
  The poll never pulls a whole transcript — `TREE_CMD` excludes the depth-two
  jsonl under `projects` because the board only wants its last 64KB, which
  `TAILS_CMD` gets — so `fetchWholeFiles` is a third call, on nobody's
  schedule but the person who ran the command. It is **framed as a tar**
  rather than a fourth delimiter: `TAILS_CMD` already learned that framing a
  live file is subtle (the `wc -c`-then-`tail -c` version spliced files
  together when one grew between the two reads), and whole multi-megabyte
  files are exactly where a second hand-rolled framing would go wrong again.
  Paths still arrive on stdin, never interpolated, and the remote shell drops
  what does not exist before tar sees the list — tar fails a whole archive on
  one missing member, and "this session has no subagents" is ordinary.
  Which remote sessions exist comes from `streamdeck-sessions.json`, not from
  a read of the script's own: attaching a session to a window is `matchFolder`
  plus the IDE locks plus a fetched tree, a join the daemon has already done.
  The honest cost, and it is stated rather than discovered — **saving a remote
  session needs the daemon running**.
  `memoryDirName` namespaces a bundle's memory directories by host because a
  slug alone collides across machines (`/home/pi/x` on two of this project's
  Pis), and it lives in the shared module because both scripts build that name
  — the save to write it, the restore to find it — and two spellings drifting
  apart lose a project's memory with no error anywhere.
  Bundles live in **`~/.claude-deck-sessions/`**, `0700`, files `0600` —
  outside `~/.claude/` on purpose. The transcripts they are made of are deleted
  on a 30-day sweep (measured: `.last-cleanup` stamped today, oldest surviving
  transcript 31 days old), outliving that sweep is the entire point of saving
  one, and the durable copy must not sit inside the directory whose retention
  policy belongs to the tool doing the deleting. A bundle is also the most
  sensitive thing this project produces — a verbatim copy of everything a
  session ever saw — so it is owner-only and deliberately unreachable from the
  board server, which binds `0.0.0.0`.
  **Both commands are in the VS Code palette** (`extension/transfer.js` —
  split out for the reason `routing.js` and `restore.js` were: a string that
  reaches a shell, in a file that can't be loaded outside an editor).
  "Backup Claude sessions" opens a **machine picker** — this
  machine and every remote host the daemon can see, each with its session
  count, multi-select with everything pre-ticked (`restoreSessions`' shape,
  and for its reason: the common case is all of them). It took the window's
  own *folder* first, and a remote host's sessions could not be reached that
  way at all — the script's filter is a substring match, and a local window's
  path never matches `/home/wouterd/...`; measured against the live daemon, 7
  remote sessions and 0 of them reachable. A separate "save all" command
  worked around that for one release and is gone with it: a picker expresses
  every combination, including the two that pair could not. The script grew
  `--host=` (repeatable, `local` for this machine) to match, independent of
  the positional folder filter still there for typing by hand.
  **Restore asks *which machine to land on* after which backup**
  (`restoreTargets`): this machine, plus every host the backup itself came
  off, plus whatever the daemon currently sees. The backup's own hosts are why
  its `manifest.json` is read — sessions taken off BEAST restore onto BEAST
  with **no path remapping whatsoever**, since their cwds already are that
  machine's, and that host drops out of the daemon's view the moment its
  window closes, which is exactly when someone reaches for a backup. The
  manifest is the archive's first member, so this costs a few hundred bytes.
  `--onto=<host>` on the script does the landing: rewritten transcripts go
  into a tree shaped like `~/.claude` either way — which for a local restore
  simply *is* `~/.claude`, and for a remote one is staging that gets pushed
  whole (`pushWholeFiles`, the mirror of the fetch, tar over ssh for the same
  framing reason). One write path, two landings, rather than two that drift.
  **The memory guard cannot follow it over**: a local restore refuses to write
  over a memory file that already exists, and a remote landing is a `tar -x`,
  which overwrites — said out loud after the fact rather than implied away.
  "Restore Claude sessions from a backup…" lists `~/.claude-deck-sessions/`
  newest first and runs the **plan** — never `--write`. A palette entry that landed
  transcripts on one click would be exactly the quiet write the daemon itself
  is not allowed to make; typing `--write` is the consent.
  The extension runs the repo's own scripts rather than reimplementing them,
  and knows where the repo is because `ext-prompt.mjs` writes the checkout path
  into a **`.deck-root` file beside the installed copy** at install time. Its
  own file, not a field in the manifest: stamping the manifest means
  re-serialising it, and a re-serialised copy differs from its source in
  whitespace and escaping (`\u2026` against a literal ellipsis) — which
  `signature()` reads as changed code *forever*, i.e. a reload prompt on every
  start. That was the first attempt and it is why `signature()` skips
  `.deck-root` explicitly. An unstamped copy says so rather than guessing a
  path to run npm in.
  **Only the *running* is gated in a remote window** (`canRunHere`), and
  the reason is the `extensionKind: ["ui"]` split biting from the other side:
  the extension host runs *locally* even for a Remote-SSH window — which is
  why it can read the local bundle directory and the local `.deck-root` at all
  — but `createTerminal` there opens a terminal on the **remote** machine, so
  the local checkout path handed to it as `cwd` doesn't exist and the terminal
  dies with `Starting directory (cwd) "…" does not exist`. Reported live from
  a remote window. Gated on `remoteName` being set at all rather than on
  `sshHost()` resolving: a dev container, WSL and a Codespace all put the
  terminal somewhere other than here, and only ssh-remote is what `sshHost`
  recognises — the question is "will the terminal land on this machine", which
  is broader than "which host is this".
  **Listing is not gated, because it works.** The backup directory is on this
  machine and the local extension host reads it from a remote window perfectly
  well — so "Restore Claude sessions from a backup…" still shows what you have
  there and copies the command to the clipboard, rather than refusing to say
  what exists. Knowing what is backed up is useful from anywhere; only landing
  it has to happen here. `canRunHere` reports the fact (`{ok, remoteName}`)
  and the wording belongs to whichever command asked, since backup and restore
  want to say different things about it.
  `sessions:restore` prints its plan and writes nothing without `--write`:
  this is the one command here that writes *Claude Code's own* transcripts
  rather than the daemon's notes to itself, which is a category the read-only
  invariant below otherwise rules out entirely — so it is a command you run,
  never a poll, and it shows you the landing site first.
- `src/accents.mjs` — the daemon's third write and its only piece of memory:
  `~/.claude/streamdeck-accents.json`, a `folderKey -> #hex` map so a project
  wears the same accent after a restart. Two functions, both best-effort — an
  unreadable file is a first run, a failed write is a restart that forgets —
  and both take `root` as a default parameter, the shape `sessions.mjs` uses,
  so `slots-check` round-trips them through a tmp dir. The read is called from
  `run()`, never at module scope: importing `index.mjs` must not touch the real
  `~/.claude`, or every check inherits this machine's live palette. `readAccents`
  drops non-string values rather than trusting the file — a half-written or
  hand-edited one would otherwise put whatever it holds straight into an SVG
  fill attribute. See the read-only invariant below for why the map it seeds is
  not what `claimAccent` treats as taken.
  **The file holds a record per project, not a colour**: `{"<key>": {"accent":
  "#4fc3f7", "order": 3}}`. A **string** value is the shape from before the
  page could reorder and is still read as that project's accent — the
  alternative was silently dropping every colour already on disk. Positions are
  sorted rather than trusted on read: they are only ever `projectOrder`'s own
  indices, but nothing stops a hand-edited file holding ties or gaps, and the
  array is what the board reads. Order lives here rather than in a fourth file
  because it is one more thing remembered about a project, and the bar for a
  new file is a reader that can't get at this one.
  It also owns `ACCENTS` — moved here from `index.mjs` because
  `config-server.mjs` needs the palette and `index.mjs` needs `openConfig` from
  `config-server.mjs`, and one of those edges has to not exist. `index.mjs`
  re-exports it, so `colors-check` and `slots-check` import it from there
  unchanged.
  **`applyAccentChoice` is the config page's mutation, and it is pure and lives
  here for the same reason `persistAccents` lives in `index.mjs`**: that
  function writes the real `~/.claude` file with no root argument, so an
  exported mutator that persisted would clobber this machine's accents with
  fixture folders on every check run. It trades with a *live* owner and
  **deletes** a closed one — handing a colour to something that isn't on the
  board is invisible, and leaving the duplicate means the collision rule
  resolves that folder's return by `readdir` order, silently taking a
  deliberate choice back days later. Because of that delete, a manual pick can
  never create the duplicate `assignSlots` exists to resolve.
- **Read-only, three install steps.** No config file of its own, and the
  daemon itself — the running process, on its 2s poll — never edits Claude
  Code's data or `settings.json`. Two of the three install steps do, though,
  and both are opt-in commands offered at `npm start` rather than anything the
  daemon runs on its own: the status line block, and now the
  PreCompact/PostCompact compaction hooks (`compact-hook.mjs`) — see
  statusline.md for why each exists and why neither is a poll-time write. The
  daemon reads from `~/.claude/`, VS Code's storage and the usage endpoint,
  and writes four files into it.
  **`sessions:restore` is the one thing in this project that writes Claude
  Code's own data** — a transcript, into `~/.claude/projects/` — and it is
  deliberately not the daemon that does it. It is a command you run, it prints
  where every file would land and writes nothing without `--write`, and it
  only ever creates transcripts that did not exist under ids it minted itself.
  Nothing about it runs on a poll. Keep it that way: the invariant below is
  about what the *daemon* does behind your back, and a two-step command you
  invoke on purpose is a different thing — but only while it stays two steps
  and stays out of the poll loop. Two are messages to the
  extension: `~/.claude/streamdeck-focus.json`, the terminal-focus request, and
  `~/.claude/streamdeck-sessions.json`, the live session list the extension's
  restore command remembers (`publish-sessions.mjs`). Both are the same shape of
  thing — one file, rewritten in place, no reader addressing, every window reads
  it and keeps what is its own — and both are best-effort in the same way: a
  window that finds neither behaves as it did before either existed. It was one
  file until the restore command needed the daemon's remote reach, which is the
  bar for a third. The sessions list is now **also read back by the next run of
  the daemon** (`seedSessionOrder`), which makes it the one file here that is
  both a message to somebody else and this daemon's own memory — deliberately,
  because it already held exactly the right rows and the alternative was a
  seventh file for a list that already existed.
  **The third is the daemon's own memory, read by nothing but the next run of
  the daemon**: `~/.claude/streamdeck-accents.json` (`accents.mjs`), which
  folder wore which accent. `folderOrder` rebuilds first-seen on every start, so
  a project reclaims its slot after a restart — but its *colour* was re-picked
  from scratch in `readdir` order, so half the board's identity survived a
  restart and half didn't. It is still not a config file: nothing in it is
  meant to be hand-edited, and a value nobody typed can always be thrown away,
  which is why every failure path reads as a first run.
  **What is remembered is not what is enforced.** `claimAccent`'s `taken` set
  is *live* folders only, never the file — with eight accents, honouring every
  remembered colour would leave every ninth project ever seen on the modulo
  fallback, and twenty projects sharing eight accents works precisely because
  only the ones on the board at once have to differ. The cost is a case that
  could not happen before: two folders that were never live together can each
  have remembered the same colour, and `assignSlots` resolves that the moment
  they meet — first one processed keeps it, the later one re-claims and the
  re-claim is written back, so the loser settles rather than flipping every
  poll.
  **The daemon also listens, and since the board it listens off this machine.**
  `config-server.mjs` is the one thing here that accepts a connection rather
  than reading a file, and it now starts with `npm start` rather than on the
  config key, bound to `0.0.0.0` rather than loopback — because the board page
  it serves is *for* an iPad, and an iPad has no other way in. `run()` prints
  the LAN URL and a QR of it (`lanAddress` picks the first non-internal IPv4,
  which a machine with a VPN or Docker up can get wrong, hence the URL printed
  as text beside the code). It still writes nothing new of its own: every
  mutation goes through `applyAccentChoice`/`moveProject` and `persistAccents`,
  into the accents file that already existed, and `focus` is the same
  `focusWindow` a key press calls — closed over the same `requestedAt`, or a
  session revealed from the iPad would read to `isRepeatPress` as one that has
  never been revealed at all.
  That is a real widening of the trust boundary and it gets the treatment the
  other one did: the per-server `randomUUID` still gates every route before
  routing, a `/focus` id is checked against the live board rather than trusted
  (it arrives from a device on the LAN and everything downstream of it reaches
  VS Code and a shell), and `STREAMDECK_NO_BOARD=1` is the off switch —
  the second in the project, beside `STREAMDECK_NO_REMOTE=1`, and for the same
  reason: this is the risky reader/listener that talks to another machine.
  Skipped, the config key still works — `openConfig` starts the same server on
  loopback instead, which is what `startServer`'s memoised promise is for: one
  server, two doors, and whichever opens first decides the bind address.
  **The fourth file is the first the daemon appends to on its own schedule**:
  `~/.claude/streamdeck-history.jsonl` (`history.mjs`), written whenever a
  session changes state rather than when you do something. Everything above it
  is rewritten in place and says what is true now; this one accumulates and
  says what was true, which is why it is the only one with a retention policy.
  **The seventh file is the first that is a credential**:
  `~/.claude/streamdeck-board.json` (`board-state.mjs`), the port and token the
  board answers on, so a page open on an iPad reconnects by itself after a
  restart instead of waiting for someone to scan a new code. `0600`, unlike
  every other file here, because the rest of `~/.claude` being user-only is not
  a reason to be careless with the one thing in it that is a bearer token.
  **The fifth file is the first whose source is outside this project's view
  entirely**: `~/.claude/streamdeck-tokens.jsonl` (`tokens.mjs`), hourly token
  totals lifted out of Claude Code's transcripts. It exists because those
  transcripts are **deleted** — `cleanupPeriodDays` defaults to 30 and is doing
  it, measured: the oldest transcript on this machine was exactly 32 days old.
  So a page that reads them live can never answer anything about last quarter
  no matter how it is cached, and copying the numbers out is the only way to
  keep them. Retention here is a year rather than a month, because outliving
  the source is the entire point. Its sixth file is a **bookmark, not data**:
  `streamdeck-tokens.pos`, which byte of each transcript has already been
  counted. It cannot live in the log — a bookmark is rewritten every pass and
  the log is only appended to — and without it every pass re-reads 2GB and
  doubles every total. It is written *after* the log, never before: a crash
  between the two re-counts a few lines, where the other order drops them for
  good. Over-counting is visible and fixable; a hole is neither.
  There is another file in this feature and the daemon does **not** write it:
  `~/.claude/streamdeck-windows/<pid>.json` is published by the extension and
  only read here. Keep it that way — a daemon that deletes files it did not
  write is a worse trade than leaving that sweep to the extension, which
  already does it (`reapDeadWindows()`, on every `activate()`): a crashed
  window's file would otherwise sit until its pid is recycled onto an
  unrelated process, at which point the liveness check starts trusting a
  frozen `focused`/`activeSessionId` from a window that died weeks ago.
  An earlier hook-based version was deleted; don't reintroduce one.
  A remote host bends "only files in `~/.claude`" further than that: a fetch
  extracts into a scratch tree at a literal `/tmp/streamdeck-remote-<pid>` —
  **not** `os.tmpdir()`. That path also anchors `fetchSource`'s
  `ControlPath` socket (that path, plus `cm-<host>`, plus ssh's own random
  suffix while the bind is in flight), which is length-checked against the
  ~104-byte Unix domain socket limit; `os.tmpdir()` on macOS is a long
  per-user path under `/var/folders` that landed exactly on that limit, so
  every fetch failed silently as an ordinary "host unreachable", with nothing
  to point at the socket path as the cause. `/tmp` is a short, stable symlink
  on macOS, and this daemon is macOS-only already. The trade this makes and
  gives up is worth recording, not just implying: `os.tmpdir()` on macOS is
  `0700`, private to the user who created it, while `/tmp` itself is
  world-writable, so a scratch directory created ahead of time under `/tmp` is
  a symlink-through target for `tar -x` — a name any local user could
  pre-create before the daemon ever runs. That stands only under this
  project's single-user macOS model; a shared machine would need the private
  directory back. Each fetch swaps that tree
  into place by rename rather than letting `tar -xf` merge it — see
  `remote-fs.mjs` above — for the same reason the daemon never merges anything
  else it's handed: a merged tree keeps what the remote host deleted.
