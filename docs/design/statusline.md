# The status line install (context gauge)

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
  dropped, the gauge simply doesn't draw — never make a missing file an error.
  Don't be tempted by the transcript's `usage` totals instead: the percentage
  needs the model's window size (1M on some, 200k on others), which the
  transcript doesn't record.
  **It was the one part of setup that could only be done by hand**, and its
  failure mode is silence: no ctx file looks exactly like a healthy machine
  mid-first-turn. `scripts/statusline-prompt.mjs` is the second `prestart`,
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
