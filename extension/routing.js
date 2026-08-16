// Which window a focus request belongs to, and what this window's own identity
// is. Split out of extension.js for one reason: that file's first statement is
// `require("vscode")`, so nothing in it can be loaded — let alone checked —
// outside a running editor. This module requires nothing, takes the two things
// it needs as plain arguments, and is exercised by scripts/extension-check.mjs.
//
// That matters more here than the line count suggests. Everything else in this
// project is checkable by running a script; the extension is the one piece whose
// bugs can only be found by reloading a window and watching. Both mistakes this
// routing has made so far were caught by reading it rather than running it.

// Only the plain `ssh-remote+<host>` form is understood. Dev containers and WSL
// encode their authority as hex JSON (`dev-container+7b22686f7374…`), which is a
// remote kind this feature does not support and must never reach `ssh`.
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The host half of a Remote-SSH window's identity, or `null`.
 *
 * `folders` is `vscode.workspace.workspaceFolders` (or `[]`), `remoteName` is
 * `vscode.env.remoteName` — both passed in rather than read, so this is a pure
 * function of them.
 *
 * A window carries a single remote authority — local and remote folders cannot
 * be mixed in one window — so folder 0 is representative rather than arbitrary.
 * The agreement is asserted anyway: it costs nothing and catches the day that
 * stops being true.
 */
function sshHost(folders, remoteName) {
  if (remoteName !== "ssh-remote" || !folders.length) return null;
  const authorities = new Set(folders.map((f) => f?.uri?.authority));
  if (authorities.size !== 1) return null;
  const [authority] = authorities;
  if (typeof authority !== "string" || !authority.startsWith("ssh-remote+")) return null;
  const host = authority.slice("ssh-remote+".length);
  return HOST_RE.test(host) ? host : null;
}

// A request older than this is ignored, so a window that was closed when the key
// was pressed doesn't act on it whenever it next opens.
const REQUEST_MAX_MS = 5000;

/**
 * Whether this window should act on a request — the whole acceptance decision,
 * in one place, because getting any part of it wrong reveals somebody else's
 * terminal rather than failing visibly.
 *
 * `null` is the local value on both sides. A request written by a daemon that
 * predates the `host` field has none at all and is read as local, which is what
 * it was: that daemon could only ever describe local sessions, so an old request
 * still works in a local window and is correctly refused by a remote one.
 *
 * **`sshHost` returning `null` does not mean "this window is local".** It says
 * so for four different situations — a dev container, a WSL window, an
 * `ssh-remote` window with nothing open, and a host this build declines to name
 * — and only the absence of `remoteName` distinguishes the genuine local case.
 * The distinction is not academic: a dev-container window's extension host runs
 * locally (`extensionKind: ["ui"]`) and reads the very same request file, but
 * its terminals resolve to *container* pids, so treating its `null` as local
 * hands it every local request to match against a pid space belonging to no
 * machine the daemon asked about.
 */
function requestIsOurs(request, { remoteName, folders = [], now = Date.now() } = {}) {
  if (!request || !Array.isArray(request.pids)) return false;
  // `ts` is checked for being a number before it is compared, because the
  // comparison alone cannot refuse a missing one: `now - undefined` is NaN, and
  // every comparison against NaN is false, so `NaN > REQUEST_MAX_MS` reads as
  // "not stale" and the request is accepted forever. The daemon always writes a
  // `ts`, so this only bites on a truncated or foreign file — but "acted on a
  // request with no timestamp, permanently" is the wrong way to fail for the
  // one guard standing between a stale press and a surprise reveal.
  if (typeof request.ts !== "number" || !Number.isFinite(request.ts)) return false;
  if (now - request.ts > REQUEST_MAX_MS) return false;
  const host = sshHost(folders, remoteName);
  if (remoteName && host === null) return false;
  return (request.host ?? null) === host;
}

module.exports = { sshHost, requestIsOurs, HOST_RE, REQUEST_MAX_MS };
