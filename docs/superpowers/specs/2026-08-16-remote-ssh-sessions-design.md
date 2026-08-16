# Remote SSH Sessions — Design

Date: 2026-08-16

**This spec is part A of three.** Pushback on 2026-08-16 found the original
bundled three features serving different goals. A is the reason the work
started: a remote session you cannot see. B and C are recorded at the bottom as
follow-ons — deferred, not cut.

- **A (here): a remote session gets a key**, with everything a local key shows
  except the context gauge.
- **B: pressing a remote key does something**, blocked on two unanswered probes.
- **C: the context gauge on remote**, which needs the status line installed
  there.

## Problem

A VS Code window opened through Remote-SSH runs its integrated terminal on the
remote host, so the `claude` process there writes its registry entry, its IDE
lock and its transcript to the *remote* `~/.claude/`. The daemon reads only the
local one. The session is therefore invisible on the deck — not dropped by
`matchFolder`, but never present in the registry to be matched at all.

Observed on 2026-08-16 with a Raspberry Pi at `192.168.2.6`:

```
local  ~/.claude/sessions/*.json    9 entries, every cwd under /Users/wouterd/…
local  ~/.claude/ide/*.lock         5 locks, all local folders
local  ~/.claude/projects/          no slug for the remote path

remote ~/.claude/sessions/2187779.json   dom-setup-2d, cwd /home/pi/domotica/dom-setup, idle
remote ~/.claude/ide/39433.lock          workspaceFolders ["/home/pi/domotica/dom-setup"]
remote ~/.claude/projects/-home-pi-domotica-dom-setup/
```

Half the system already sees the window: the extension is `extensionKind: ["ui"]`,
so its host runs locally even in a remote window (verified — pid 41711 is a local
`Code Helper (Plugin)`), and it publishes

```json
{"folders":["/home/pi/domotica/dom-setup"],"focused":false,"activeSessionId":null}
```

A folder with no session, next to sessions with no folder.

## Goal

A remote session gets a key carrying what a local key carries: project accent,
state colour, `aiTitle` body, task counter, subagent markers, detail board,
attention queue. The context gauge is the one exception and is spec C — it
exists only because a status line writes it, and the remote has none.

Pressing a remote key is spec B. Until it ships, a remote key is a status light:
it reads, it does not act.

## Non-goals

- Remote kinds other than Remote-SSH. Dev containers and WSL encode their
  authority as hex JSON (`dev-container+7b22686f7374…`, observed in
  `state.vscdb`); only the plain `ssh-remote+<host>` form is supported, and
  everything else parses to `null`.
- Discovering hosts the user has not opened a VS Code window on. The window is
  the trigger; there is no host list, no scan, no config file.
- Bidirectional anything. The remote never initiates a connection to the Mac.

## Rejected approaches

**Reusing VS Code's own SSH connection.** Its process is
`ssh -v -T -D 60808 -o ConnectTimeout=15 192.168.2.6` — no `-M`/`-S`, so there
is no ControlMaster socket to attach to, and the `-D` tunnel carries the
`vscode-server` protocol. Nothing to piggyback. We open our own connection,
which works today: `~/.ssh/config` already has the host with key auth, and
`BatchMode=yes` succeeds unattended.

**Running `sessions.mjs` itself on the remote** (`ssh host node -`, module on
stdin). Would have been the neatest — one implementation, always current. Dead:
the Pi has no node (python3 3.12 and jq only).

**Reimplementing the readers in Python on the remote.** One SSH round trip and
no bandwidth waste, but `readTranscriptSignals` — `/clear` truncation,
`startedEmpty`, `blockedOnDenial`, the `/compact` marker, model and effort —
would exist twice in two languages. That code is the subtlest in the repo and
every one of those rules was arrived at by being wrong first; three corrections
landed in the week this spec was written, the newest (`f2535ae`) fixing markers
that matched raw text instead of parsed JSON. A second copy drifts silently and
the deck is the only place the drift shows.

**Any collector script on the remote, in any language.** The weaker version of
the same mistake, and the one this spec originally made. A script has to know
which files matter, which means knowing that a registry entry has a `cwd` and a
`sessionId` and how a cwd becomes a project slug. None of that needs to be
remote: the daemon already computes every one of those paths, from a registry it
can fetch first. Two plain shell round trips replace the script, and with it the
question of what any given host has installed — which is not academic, since the
two hosts here are a Raspberry Pi and a different machine entirely.

**Materialising transcripts locally as sparse files.** Proposed during review, so
that `tailLines` could run unmodified on a file with a hole where the unread
megabytes belong. Measured and rejected: `ftruncate` + a tail write on APFS
allocates the full length (a 233,880-byte transcript occupied 237,568 bytes on
disk, no hole). The `whole` semantics did come out right, but a 4.7MB transcript
rewritten every 2s is ~2.3MB/s of SSD churn, and every remote transcript would
permanently occupy its full size in zeros.

**Live SSH filesystem adapter**, one `ssh` per primitive. Nothing to install
remotely, but 15–40 round trips per host per poll. Fine at the measured 20ms of
a warm multiplexed LAN connection, not fine at 80ms.

**rsync mirror** into `~/.claude/remote/<host>/`, with the existing readers
pointed at that root. Smallest diff, no adapter — but a background sync
process, a disk copy of transcripts up to 4.7MB, the Pi re-checksumming them
every 2s, and `isAlive` still needs a side channel because it is a local
`process.kill`.

## Approach: fetch with shell, inject three things

Every path in `sessions.mjs` derives from one constant (`CLAUDE_DIR`,
`sessions.mjs:5`) — the other five directories are `join(CLAUDE_DIR, …)`. So the
host-dependent surface is not the module's whole I/O layer. It is three things:
where the tree is, whether a pid is alive, and how a transcript tail is read.

- **`root`** — the small files (`sessions/`, `ide/`, `tasks/`, subagent
  `.meta.json`) come over as a tar stream and land in a scratch tree. Every
  existing reader runs against them unmodified, on real files.
- **`isAlive`** — membership in the pid list the remote sends, never a local
  `process.kill`.
- **`tail(path)`** — the one function whose semantics cannot be faked cheaply.

`tail` is injected rather than emulated because of `whole`. `tailLines` derives
it from a byte offset (`whole: start === 0`, `sessions.mjs:120`), and
`startedEmpty` — added the day this spec was written, `ae2415d` — is only
trustworthy when it is right. Any in-memory or truncated-file stand-in has to
reproduce that offset arithmetic exactly, and getting it wrong doesn't crash: it
makes a busy remote session read `CLEAR`. The remote already sends the true byte
size, so `whole` is transported as a fact (`size <= 65536`) instead of being
reconstructed. No transcript ever touches local disk.

Nothing on the remote parses anything. Measured warm, multiplexed:

```
tar -cf - sessions ide            → 105ms   small JSONs, extracted to the scratch tree
wc -c < <t> && tail -c 65536 <t>  → 189ms   true size, then the tail
```

The daemon computes which transcripts to ask for from the registry it fetched in
the first call, using `projectDirFor`/`transcriptPathFor` — the same functions
that resolve a local path.

### 1. Host discovery

`extension/extension.js:116` currently keeps only `f.uri.fsPath`. Add:

```js
const wf = vscode.workspace.workspaceFolders ?? [];
// …
host: vscode.env.remoteName === "ssh-remote" ? sshHost(wf[0]?.uri.authority) : null,
```

`wf[0]` is representative, not arbitrary: a window carries a single remote
authority — local and remote folders cannot be mixed in one window — so every
folder in a remote window has the same one. The extension asserts they agree and
publishes `null` if they ever don't, which costs nothing and catches the day that
stops being true.

where `sshHost` returns the remainder of a plain `ssh-remote+<host>` authority
and `null` for anything else — a hex-encoded authority is a remote kind this
feature does not support, and must not be passed to `ssh`.

`window-state.mjs` validates `host` and returns it. Its read lands inside
`deck.on("down")`, so it still may not throw.

**That validation is stricter than the one next to it, and the reason is worth
stating.** `folders` is checked for being strings because a non-string would
reach `folder.endsWith` and throw inside a synchronous press handler. `host`
gets checked because it reaches `ssh` as an argument. The file was written on the
assumption that nothing it returns is executed; this spec ends that assumption,
so the value is pinned to `^[A-Za-z0-9][A-Za-z0-9._-]*$` with an optional
`<user>@` prefix, in `sshHost` and again on read. A leading `-` is the specific
hazard: `ssh` would take `-oProxyCommand=…` as an option and run it *locally*,
and `execFile` does not help, because the parsing is `ssh`'s own. The host is
also passed after `--`.

This costs an extension version bump, which means a remote window shows nothing
until it is reloaded. That is the existing, documented failure mode of every
extension change here, and `prestart`'s drift check already names it.

### 2. Fetching

New `src/remote-fs.mjs`. No file is installed on the remote and no interpreter is
assumed beyond a POSIX shell.

Every call carries the same options, so connections multiplex and a hung link
cannot stall the poll:

```
ssh -o BatchMode=yes -o ConnectTimeout=5 \
    -o ControlMaster=auto -o ControlPath=<socket> -o ControlPersist=60 <host>
```

**Call 1 — the tree and the pids.** One command, two streams kept apart by
fetching the pid list first and the tar after it:

```sh
cd ~/.claude && ls /proc | grep '^[0-9]*$' && echo --- && tar -cf - sessions ide tasks 2>/dev/null
```

`ls /proc` rather than `ps`, so the pid list needs no output-format parsing and
no assumption about which `ps` the host ships.

**The tree is replaced, never merged.** Each fetch extracts into a fresh
directory and renames it over the previous one, which is then unlinked. `tar -xf`
merges, and a merged tree keeps what the remote deleted — with consequences the
pid list cannot catch, because only one of the four things in there has a pid:

- a closed window's `ide/*.lock` lingers, so `matchFolder` keeps matching a
  folder with no window, silently defeating the invariant the whole join exists
  to enforce;
- `tasks/<id>/` keeps a finished session's task list on the detail board;
- a stale `sessions/<pid>.json` survives its own liveness check the moment the
  remote recycles that pid — the failure `CLAUDE.md` already treats as real for
  `streamdeck-windows`, and a Pi recycles pids faster than a Mac.

Renaming rather than `rm -rf`-then-extract also means a reader sees the old
complete tree or the new one, never a half-written one. The scratch path carries
the daemon's pid, so two daemons — normal here, where work happens in worktrees —
do not share a tree.

**Call 2 — the tails.** The daemon now has the registry, so it resolves each
live session's transcript with the same `projectDirFor`/`transcriptPathFor` it
uses locally, and asks for exactly those:

```sh
while IFS= read -r f; do wc -c < "$f"; tail -c 65536 "$f"; done
```

The paths go over **stdin, one per line — never interpolated into the command
string.** A `cwd` with a space or an apostrophe in it is an ordinary thing to
have and would otherwise split the loop or unbalance a quote; the malicious
reading of the same hole is secondary to the accidental one.

The byte count precedes each tail, which both frames the stream and carries
`whole`. Subagent transcripts and their `.meta.json` are fetched the same way,
`.meta.json` riding along in call 1's tar via `projects/`.

Extraction refuses absolute and `../` members, so a stream cannot write outside
the scratch tree.

Two round trips, ~300ms warm, none of it on the poll's critical path.

`ctx/` is not fetched — that is spec C. Process ancestry is not fetched — that is
spec B.

**Deferred:** send the previously seen `{path: mtime}` so unchanged tails come
back empty and are served from cache. Worth it if a WAN link or a busier Pi
complains. Not in v1; a `ponytail:` comment names the ceiling.

### 3. The three injection points

`getLiveSessions(sources = [localSource])` maps each source through the existing
body and concatenates. A source is `{ host, root, isAlive, tail }`:

| | local | remote |
|---|---|---|
| `root` | `~/.claude` | `<scratch>/<host>` |
| `isAlive` | `process.kill(pid, 0)` | membership in call 1's pid list |
| `tail` | today's `tailLines` | call 2's bytes, `whole = size <= 65536` |

Every session carries `host` (`null` for local), which reaches `index.mjs`.

`isAlive` must be per source. A remote pid checked against the local process
table either drops a live session or, worse, matches an unrelated local process.

### 4. Collisions

Two hosts make two previously-safe assumptions false, and this user already has
two SSH remotes configured (`192.168.2.6`, `192.168.2.70`).

**Folder identity.** `folderOrder`, `folderAccent`/`accentFor` and the
`visible[i - 1].folder !== s.folder` block test in `index.mjs` all key on the
folder path. `/home/pi/x` on two hosts is one key today, which would merge two
projects into one block and one accent. Folder identity becomes `host:folder`.

**Window matching.** `isRepeatPress` matches published window folders against
session folders through `matchFolder`. A remote window's folder must not match a
local session's cwd, so the same host qualification applies there.

**Nested attachment.** `nestedFor` decides which key a nested session's marker
lands on. Its `parent` branch is already safe — a session id is globally unique,
so it is host-scoped by construction. Its *fallback*, for SDK-entrypoint sessions
that carry no `parent`, compares bare folders: two hosts at the same path each
match the other's SDK session, so one host's subagent draws its marker on the
other's key and feeds `mostUrgent` for a project it has nothing to do with.

This third site was missed when this section was first written and found in
review of the implementation. It is worth stating why the omission was easy:
the first two are about *ordering and colour*, which is where "same folder"
obviously matters, while this one is about *attachment*, which reads like a
parent-child question until you notice half its cases have no parent.

### 5. Overflow: nothing changes, deliberately

Remote sessions join the single pool and take slots in first-seen order like
everything else. No tier, no cap, no precedence over local sessions — raised
during review and rejected, because there is no conceptual difference between
the two and any ordering rule would be arbitrary.

The 13-slot overflow this makes more likely is already handled, one layer up:
`assignSlots` drops the surplus (`ordered.slice(0, slots.length)`), but
`attentionQueue` is passed the **whole** session list, not the visible one. A
session with no key still counts toward the attention key, still pulses it, and
still gets a tile on the attention board. So the case that matters — something
wants you and has nowhere to say so — cannot happen, whether the session is
local or remote.

A slotless session that is merely busy stays invisible. That is correct: the
board cannot show everything, and "busy" is not a claim on your attention.

### 6. Failure

SSH is on no critical path.

- One fetch per host per interval, cached, in-flight deduped. **The deduping is
  load-bearing, not hygiene**: `lastAt` is stamped when a fetch finishes, so
  without an explicit in-flight claim a slow fetch stays "due" for its whole
  duration and the next tick starts a second one against the same staging
  directory and ControlPath.
- **The poll reads the cache; it never waits for a fetch.** This sentence
  originally read "`ConnectTimeout=5` plus a hard kill, so a hung link cannot
  stall the 2s loop", and that was false as first built. A fetch is two
  *sequential* ssh calls, each bounded by a 15s kill, so awaiting one inline
  added up to ~30s to a tick — pausing every key's redraw, local ones included,
  because another machine was unreachable. A bounded stall is still a stall.
  The fetch is therefore started and not awaited, and the poll draws whatever
  the last one produced. The cost is one poll of staleness when a remote window
  first appears: freshness, never frames.
- Consecutive failures back off 5s → 10s → 30s and one success resets, the shape
  `usage.mjs` already uses for 429s.
- A failing host's keys vanish, the way a closed window's do. Logged once per
  transition, not per poll.
- Nothing throws into the poll loop, matching every other reader here.
- `STREAMDECK_NO_REMOTE=1` skips every remote source. Every other risky reader
  here degrades to nothing by itself; this one holds an open connection to
  another machine, so it gets a way to be switched off without killing the
  daemon.

**Remote hosts poll slower than local: `REMOTE_POLL_MS`, 6s.** "Not on the
critical path" is a statement about the daemon, not about the host. Two round
trips every 2s forever, plus a permanently held `ControlPersist` connection, is
a constant background load on a machine doing real work — here, a Raspberry Pi
running home automation. Nothing on a remote key changes faster than it can be
read, so the slower cadence costs nothing visible and is one constant rather
than a new piece of state.

### 7. The window count diagnostic

`countVsCodeWindows` counts local `~/.claude/ide/*.lock` files as the denominator
for the "N of M windows have the extension" log line — the only diagnostic for
the one failure this feature reliably produces, a window running the old build
because it hasn't been reloaded.

A remote window publishes its state (numerator) while its lock sits on the remote
(uncounted), so the line reads "6 of 5". Published remote windows are counted
into the denominator so the two sides describe the same population.

### 8. Checks

- `scripts/remote-check.mjs` — a fixture tree on disk plus a canned pid list and
  canned tails, run through `getLiveSessions` as a second source, asserting the
  result matches what the local source produces from the identical fixtures. The
  point of the assertion is that the two sources cannot diverge. Plus `sshHost`
  parsing (plain form, hex authority, no authority), the `whole` boundary at
  exactly 65536 bytes, and both collision guards.
- No check opens an SSH connection.

## Follow-on specs

**B — pressing a remote key.** Blocked on two probes, each ~10 minutes:

1. Does a `ui` extension host resolve `Terminal.processId` for a remote
   terminal? If yes, terminal focus is the ancestry walk run against a remote
   `ps` fetched alongside the tree, plus `host` on the focus request so a local window
   holding an equal pid does not reveal an unrelated terminal. If no, terminal
   focus is out for remote.
2. Does `code --file-uri vscode-remote://…` focus the existing window, or
   replace/spawn? `docs/roadmap-reveal-terminal.md` ruled out the `code` CLI for
   *local* windows, where `open -a` works; this case is untested. If it spawns,
   remote presses cannot raise a window and that degradation is documented
   rather than worked around.

Until B ships, `focusWindow` must short-circuit on a remote session rather than
run `anchorFile`/`openFileIn` against a remote path on the local filesystem.

**C — the context gauge on remote.** `npm run remote:install -- <host>` merges
the status line block README documents into the remote's
`~/.claude/settings.json` and drops the script. Manual and explicit — never in
`postinstall`, which would make `npm install` write to another machine. Until
run, the file is absent and the gauge does not draw, exactly as on a local
machine without a status line. This is the one place the daemon's "reads
everything, writes one file" rule bends, and it bends in a separate opt-in
command, not in the poll loop.
