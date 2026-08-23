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

/**
 * Save the sessions of one window's folder.
 *
 * The folder is passed as the save command's filter rather than saving
 * everything: this command is offered per window and named for it, and a
 * command that quietly bundled another project's conversations too would be
 * doing more than it said.
 */
function saveCommand(folder) {
  if (!folder) throw new Error("no folder to save");
  return `npm run sessions:save -- ${shellQuote(folder)}`;
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

module.exports = { bundleList, isBundleName, restorePlanCommand, saveCommand, shellQuote, BUNDLE_RE };
