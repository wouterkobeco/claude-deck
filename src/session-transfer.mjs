// Moving Claude Code sessions between machines: what goes in a bundle, and
// where every piece of it lands on the other side.
//
// **A session is one file.** `~/.claude/projects/<slug>/<id>.jsonl`, where the
// slug is the session's cwd with every non-alphanumeric character replaced by
// a dash. Nothing else is needed to resume one — no registry entry (those are
// live-process only), no config. Measured end to end: a transcript whose id
// and cwd were rewritten, dropped into the matching slug on a path that had
// never seen it, resumed with its whole conversation intact.
//
// **The slug must match the destination cwd.** The same transcript filed under
// a non-matching slug answers `No conversation found with session ID`, so a
// transfer that gets this wrong fails silently-ish at the worst moment. That
// is the entire reason `projectSlug` is imported from sessions.mjs rather than
// re-derived here.
//
// Everything in this file is pure and takes its inputs as arguments; the two
// commands under scripts/ do the reading, writing and tarring. That split is
// the same one `statusline.mjs` and `accents.mjs` make, and for the same
// reason: the arithmetic is where being wrong is invisible, and a check has to
// be able to drive it without touching the real ~/.claude.
import { randomUUID } from "node:crypto";
import { projectSlug } from "./sessions.mjs";

export { projectSlug };

// Where bundles live: a directory of this daemon's own, not inside
// ~/.claude/. The transcripts a bundle is made of are **deleted on a 30-day
// sweep** (measured on this machine: `.last-cleanup` stamped today, oldest
// surviving transcript 31 days old), and outliving that sweep is the whole
// point of saving one — so the durable copy must not sit inside the directory
// whose retention policy belongs to the tool doing the deleting. It is also a
// different kind of thing from the daemon's other files there: those are small
// notes to itself, these are multi-megabyte archives that accumulate.
export const BUNDLE_DIR_NAME = ".claude-deck-sessions";

// A bundle is a full verbatim conversation — file contents, command output,
// anything a session ever saw. The most sensitive thing this project produces,
// so the directory and every file in it are owner-only, and nothing about this
// is reachable from the board server (which binds 0.0.0.0 for the iPad).
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A session id is a UUID; anything else is refused rather than sanitised, the same call `isPathSafeId` makes. */
export const isSessionId = (id) => typeof id === "string" && SESSION_ID_RE.test(id);

/** `2026-08-23-1052` — sorts lexically, which is also chronologically. */
export function bundleName(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * What a bundle says about itself. Written as the archive's first member so a
 * restore can list what is in one without unpacking megabytes of transcript —
 * which is also why there is no separate index file to drift out of sync.
 *
 * `folder` and `cwd` are both recorded and they are genuinely different: a
 * worktree session's cwd sits *under* its window's folder, and the remap has
 * to preserve that suffix rather than flattening every session in a project
 * onto one destination path.
 */
export function buildManifest(sessions, now, host) {
  return {
    version: 1,
    savedAt: new Date(now).toISOString(),
    host: host ?? null,
    sessions: sessions.map((s) => ({
      id: s.session_id,
      folder: s.folder,
      cwd: s.cwd,
      title: s.title ?? null,
      subagents: s.subagents ?? 0,
      // Which machine it came off, for the restore to show. It changes nothing
      // about where the session lands — that is `folderMap`'s job either way —
      // but "this one is the Pi's" is the difference between recognising a
      // path and guessing at it, when two machines lay their projects out
      // alike.
      host: s.host ?? null,
    })),
    // Distinct project directories, for the per-project `memory/` that rides
    // along beside the transcripts.
    // Keyed by host as well as cwd: two machines really can hold the same path
    // (`/home/pi/x` on two Raspberry Pis is a live case for this project), and
    // one memory directory must not stand in for the other's.
    projects: [...new Map(sessions.map((s) => [`${s.host ?? ""}\u0000${s.cwd}`, s])).values()].map((s) => ({
      cwd: s.cwd,
      host: s.host ?? null,
      slug: projectSlug(s.cwd),
    })),
  };
}

/**
 * What a project's `memory/` is called *inside* a bundle.
 *
 * Namespaced by host, because a slug alone collides across machines:
 * `/home/pi/x` exists on two of this project's Raspberry Pis, and one of
 * their memory directories standing in for the other's would be a quiet,
 * unrecoverable mix-up. `@` rather than `:` because this is a path component
 * on whatever filesystem the bundle is unpacked on.
 *
 * Here rather than in either script because both of them build it — the save
 * to write it, the restore to find it — and two spellings that drift apart
 * lose a project's memory with no error anywhere.
 */
export function memoryDirName(project) {
  return project.host ? `${project.host}@${project.slug}` : project.slug;
}

/**
 * A source cwd rewritten onto the destination machine's own path.
 *
 * Prefix substitution rather than wholesale replacement, because a session's
 * cwd is not always its folder: a worktree session's cwd is
 * `<folder>/.claude/worktrees/<name>`, and replacing the whole thing would
 * file every worktree in a project under the project's own slug — where the
 * worktree's own resume would then not find it. Anything that isn't under the
 * folder is left alone and reported, since there is nothing honest to map it
 * to.
 */
export function remapCwd(cwd, folder, destFolder) {
  // Trailing slashes are normalised away first: a folder read from VS Code
  // carries none and one read from a hand-written mapping may, and the two
  // spellings of the same directory must not be a silent non-match — which,
  // at the far end, is a session filed where resume will not look.
  const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const from = trim(cwd);
  const at = trim(folder);
  const to = trim(destFolder);
  if (from === at) return to;
  if (from.startsWith(at + "/")) return to + from.slice(at.length);
  return null;
}

/**
 * Rewrite one transcript's machine-specific fields.
 *
 * Two kinds of field, and both matter. `sessionId`/`session_id` become the new
 * id — a *fresh* one on every restore, so a session restored while the source
 * machine still has it cannot end up as two machines appending divergent
 * histories under one id. `cwd` becomes the destination path, on every line
 * that carries one (~1700 of them in a real transcript).
 *
 * What is deliberately **not** rewritten: `file-history-delta`,
 * `file-history-snapshot` and `frame-link` records carry absolute paths into
 * scratch and backup directories that simply do not exist on the other
 * machine. Rewriting them would invent files; they are left as they are, the
 * conversation resumes fine, and only the undo/file-history feature is poorer
 * for it. That is the honest trade and it is worth knowing about rather than
 * papering over.
 *
 * Unparseable lines are passed through untouched rather than dropped: a
 * transcript is written by another process and its last line is routinely half
 * written, and losing a line loses a turn.
 */
export function rewriteRecords(lines, { newId, cwdFor }) {
  return lines.map((line) => {
    if (!line.trim()) return line;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return line;
    }
    if (!d || typeof d !== "object") return line;
    if ("sessionId" in d) d.sessionId = newId;
    if ("session_id" in d) d.session_id = newId;
    if (typeof d.cwd === "string") d.cwd = cwdFor(d.cwd) ?? d.cwd;
    return JSON.stringify(d);
  });
}

/**
 * Where every piece of a bundle lands, and under what id — computed whole
 * before anything is written, so a mapping that cannot be satisfied is a
 * refusal rather than a half-restored machine.
 *
 * `folderMap` is source folder -> destination folder. A session whose folder
 * isn't in it is skipped and reported: guessing a destination for a project
 * this machine may not even have a checkout of is how a restore ends up
 * filing a session where nobody will look for it.
 *
 * `newIdFor` is injectable purely so a check can assert on the plan; the
 * default is a real UUID, which is the point of the whole fresh-id rule.
 */
export function planRestore(manifest, folderMap, newIdFor = () => randomUUID()) {
  const plan = [];
  const skipped = [];
  for (const s of manifest.sessions ?? []) {
    if (!isSessionId(s.id)) {
      skipped.push({ ...s, why: "not a session id" });
      continue;
    }
    const destFolder = folderMap[s.folder];
    if (!destFolder) {
      skipped.push({ ...s, why: "no destination folder given for this project" });
      continue;
    }
    const destCwd = remapCwd(s.cwd, s.folder, destFolder);
    if (!destCwd) {
      skipped.push({ ...s, why: `cwd is not under its folder (${s.cwd})` });
      continue;
    }
    plan.push({
      sourceId: s.id,
      newId: newIdFor(s),
      sourceCwd: s.cwd,
      destCwd,
      destSlug: projectSlug(destCwd),
      title: s.title ?? null,
      host: s.host ?? null,
      subagents: s.subagents ?? 0,
    });
  }
  return { plan, skipped };
}

/**
 * The command a restored session is opened with. Same shape the extension's
 * own restore uses, and re-checked here for the same reason: this string
 * reaches a shell, and the id in it came out of a file another machine wrote.
 */
export function resumeCommand(id) {
  if (!isSessionId(id)) throw new Error(`not a session id: ${id}`);
  return `claude --resume ${id}`;
}
