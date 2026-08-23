// The decidable half of the two session-transfer commands: which bundles are
// offerable, and exactly what gets typed into a terminal.
//
// Split out of extension.js for the reason routing.js and restore.js were:
// that file opens with `require("vscode")` and so cannot be loaded outside a
// running editor, which makes it the one place where a mistake is only found
// by reloading a window and watching. Everything here is a plain function over
// plain data, and `extension-check` drives it.
//
// The work itself is deliberately **not** here. Bundling and restoring
// transcripts lives in the repo's own scripts, and these commands run them —
// one implementation, in the place that already has a check driving its
// arithmetic. What the extension adds is the part only an editor can: which
// window you meant, and a picker over what is on disk.

// A bundle name reaches a shell. It is read off a directory listing rather
// than typed, but that directory is an ordinary one a person can drop files
// into, so the name is matched against what this tool writes — a date-stamped
// `.tgz` — rather than escaped and hoped for. Refuse rather than sanitise, the
// same call `SESSION_ID_RE` makes one file over.
const BUNDLE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}\.tgz$/;

const isBundleName = (name) => typeof name === "string" && BUNDLE_RE.test(name);

/**
 * Single-quote a path for a POSIX shell.
 *
 * Every path in these commands is a real directory on this machine, not
 * anything hostile — but a project called `it's mine` is an ordinary thing to
 * have and would otherwise end the quoted string and take the rest of the
 * command with it. `'\''` is the only way to get a single quote inside single
 * quotes, and it is worth having exactly once, checked, rather than at each
 * call site.
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The newest bundles first, ignoring anything that isn't one of ours.
 *
 * Names sort lexically because `bundleName` writes them `YYYY-MM-DD-HHMM`,
 * which is also chronological — the whole reason for that format.
 */
function bundleList(names) {
  return (names ?? []).filter(isBundleName).sort().reverse();
}

// A hostname reaches `ssh`. The picker builds these from the daemon's own
// published list, but "the caller is trusted" is the assumption that stops
// being true the first time someone scripts it.
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The machines that have something to save, from the list the daemon
 * publishes — this one first, then each remote host, with how many sessions
 * each is holding.
 *
 * `"local"` is the sentinel for this machine, matching what the save command
 * takes. A real host called `local` would collide, which is a name nobody
 * gives an ssh target and not worth a second flag to rule out.
 *
 * The count is computed here rather than left to the picker because it is the
 * whole reason a picker is worth showing: "BEAST — 7 sessions" is a choice, a
 * bare address is a guess.
 */
function machineChoices(rows) {
  const counts = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r.id !== "string") continue;
    const host = r.host ?? "local";
    if (host !== "local" && !HOST_RE.test(host)) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const remote = [...counts.keys()].filter((h) => h !== "local").sort();
  return [...(counts.has("local") ? ["local"] : []), ...remote].map((host) => ({
    host,
    label: host === "local" ? "This machine" : host,
    count: counts.get(host),
  }));
}

/**
 * Save the sessions of the machines picked.
 *
 * Machines, not the window's own folder, which is what this used to take. A
 * remote host's sessions were unreachable that way: the script's folder filter
 * is a substring match, and a local window's path never matches
 * `/home/wouterd/...` — measured against the live daemon, 7 remote sessions
 * and 0 of them reachable from this checkout's window. Picking the machine
 * says what it does and can express every combination, which is why the
 * separate "save all" command that worked around it is gone rather than kept
 * beside it.
 */
function saveCommand(hosts) {
  const picked = (hosts ?? []).filter((h) => h === "local" || HOST_RE.test(h));
  if (!picked.length) throw new Error("no machine to save");
  return `npm run sessions:save -- ${picked.map((h) => `--host=${shellQuote(h)}`).join(" ")}`;
}

/**
 * Show what restoring a bundle *would* do. Never `--write`.
 *
 * The extension deliberately stops at the plan. Restoring writes Claude
 * Code's own transcripts — the one thing in this project that does — and a
 * palette entry that did it on one click would be exactly the kind of quiet
 * write the daemon is not allowed to make either. The plan names the files and
 * the command that lands them; typing `--write` is the consent.
 */
function restorePlanCommand(bundle) {
  if (!isBundleName(bundle)) throw new Error(`not a bundle: ${bundle}`);
  return `npm run sessions:restore -- ${shellQuote(bundle)}`;
}

/**
 * Whether these two commands can run in this window at all.
 *
 * They can't in a remote one, and the failure is nastier than it sounds. This
 * extension is `extensionKind: ["ui"]`, so its host runs **locally** even for a
 * Remote-SSH window — that is the whole reason it can read the local bundle
 * directory and the local `.deck-root`. But `createTerminal` in a remote window
 * opens a terminal on the **remote** machine, so the local checkout path it is
 * handed as `cwd` does not exist there and the terminal dies with
 * `Starting directory (cwd) "…" does not exist`. Two machines, one command, and
 * nothing in the API that lets a UI extension open a local terminal in a remote
 * window.
 *
 * Gated on `remoteName` being set at all rather than on `sshHost()` resolving:
 * a dev container, WSL and a Codespace all put the terminal somewhere other
 * than here, and only ssh-remote is what `sshHost` recognises. The question
 * here is "will the terminal land on this machine", which is a different and
 * broader one than "which host is this".
 *
 * Refused rather than worked around, because there is nothing here to work
 * around: the bundles, the scripts and the daemon are all on the local machine,
 * and `sessions:save` only ever bundles local sessions anyway. A remote window
 * has nothing of its own to offer these commands.
 */
function transferAvailability(remoteName) {
  if (!remoteName) return { ok: true };
  return {
    ok: false,
    reason: `Claude sessions: this window is remote (${remoteName}), and its terminals run on that machine. Save and restore run where the deck does — open one of this Mac's own windows and try there.`,
  };
}

module.exports = {
  bundleList,
  isBundleName,
  machineChoices,
  restorePlanCommand,
  saveCommand,
  shellQuote,
  transferAvailability,
  BUNDLE_RE,
};
