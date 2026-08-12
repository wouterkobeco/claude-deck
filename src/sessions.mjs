import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const IDE_DIR = join(CLAUDE_DIR, "ide");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const TASKS_DIR = join(CLAUDE_DIR, "tasks");
const CTX_DIR = join(CLAUDE_DIR, "ctx");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const TITLE_TAIL_BYTES = 65536;

async function readJsonFiles(dir, suffixes = [".json"]) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of names) {
    if (!suffixes.some((s) => name.endsWith(s))) continue;
    try {
      results.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // partial write or corrupt file — skip it, not a crash
    }
  }
  return results;
}

function isUnder(path, folder) {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : folder + "/");
}

/**
 * Matches a session's cwd to the open VS Code window it belongs to. An exact
 * match always wins over an ancestor match — a worktree opened as its own
 * window is a real session, not a nested one. Among ancestor-only matches,
 * the most specific (longest) folder wins, so a session nested several
 * levels deep attaches to its closest open ancestor rather than whichever
 * folder happened to come first in lock-file order.
 */
export function matchFolder(cwd, folders) {
  // isUnder already tolerates a trailing slash on `folder`; strip one from
  // `cwd` too so an incidental trailing slash there can't make an exact
  // match miss and fall through to being misclassified as nested.
  const target = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (folders.includes(target)) return { folder: target, nested: false };
  const ancestors = folders.filter((f) => isUnder(target, f));
  if (ancestors.length === 0) return null;
  const folder = ancestors.reduce((best, f) => (f.length > best.length ? f : best));
  return { folder, nested: true };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code stores a session's transcript under a directory named after its
 * cwd, with every `/` and `.` flattened to `-`.
 */
function transcriptPathFor({ cwd, sessionId }) {
  return join(PROJECTS_DIR, cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
}

// /clear writes a plain command line into the same transcript rather than
// starting a new file, so a naive backward scan for aiTitle would keep
// surfacing the pre-clear summary as if the fresh context were still about
// that. This is the literal tag Claude Code writes for it.
const CLEAR_MARKER = "<command-name>/clear</command-name>";

// A denied-by-auto-mode tool result comes back as an ordinary `type:"user"`
// line (it's a tool_result, so it's on the user turn) carrying this field.
// Every transcript line's own top-level `type` is written before any nested
// `message.type`, so this substring reliably means *this* line, not some
// tool_use/tool_result payload mentioning "user" inside its content.
const USER_LINE_MARKER = '"type":"user"';

/**
 * Two things read from the same tail scan of a session's transcript, since
 * reading the whole file to find either doesn't scale:
 *
 * `aiTitle` — Claude Code writes this field (an AI-generated summary, the
 * same string VS Code's terminal list shows) onto transcript lines repeatedly
 * as a session progresses; this is the most recent one. `clearedEmpty` is
 * true when a `/clear` was crossed before any aiTitle was found scanning
 * backwards: nothing has happened in the session since, as far as this tail
 * window can see, so a title from before it would describe a conversation
 * that's gone.
 *
 * `blockedOnDenial` — true when the most recent `type:"user"` line (newest
 * first) is a tool-call denied by the auto-mode classifier, with nothing from
 * the human since. Claude Code's own session status goes "idle" once that
 * turn ends, identical to any other turn that ended cleanly — this is the one
 * way we can tell that idle actually means "asked you for permission and is
 * waiting," not "waiting for whatever's next." It's a narrow signal, not
 * proof: an assistant that recovers and keeps working without another human
 * line in between would also match, until it either says something (ending
 * the turn, but by then it's usually done exactly what this flags) or you
 * reply. Good enough for a key that just needs your attention, not a promise.
 */
export async function readTranscriptSignals(transcriptPath) {
  let fh;
  try {
    fh = await open(transcriptPath, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - TITLE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read({ buffer, position: start });
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");

    let aiTitle = null,
      clearedEmpty = false,
      titleResolved = false;
    let blockedOnDenial = false,
      denialResolved = false;

    for (let i = lines.length - 1; i >= 0 && (!titleResolved || !denialResolved); i--) {
      const line = lines[i];

      if (!titleResolved) {
        if (line.includes("aiTitle")) {
          try {
            const obj = JSON.parse(line);
            if (typeof obj.aiTitle === "string" && obj.aiTitle) {
              aiTitle = obj.aiTitle;
              titleResolved = true;
            }
          } catch {
            // truncated line at the start of the tail slice — keep scanning
          }
        }
        if (!titleResolved && line.includes(CLEAR_MARKER)) {
          clearedEmpty = true;
          titleResolved = true;
        }
      }

      if (!denialResolved && line.includes(USER_LINE_MARKER)) {
        blockedOnDenial = line.includes("toolDenialKind");
        denialResolved = true;
      }
    }

    return { aiTitle, clearedEmpty, blockedOnDenial };
  } catch {
    return { aiTitle: null, clearedEmpty: false, blockedOnDenial: false };
  } finally {
    await fh?.close();
  }
}

/**
 * Works out "task X of Y" for a list of tasks.
 *
 * Two numbering schemes, because a list's own numbering can disagree with its
 * length: a plan whose items are named "Task 4..Task 10" is eight files long,
 * so its in-progress item sits at position 3 while everyone involved calls it
 * task 6. When the subjects carry explicit numbers those win; otherwise the
 * position in the list is used.
 *
 * X is the in-progress task, or the furthest-along completed one when nothing
 * is running, so the pair stays on one scheme instead of flipping.
 */
export function taskCounter(tasks) {
  const numbers = tasks.map((t) => {
    const match = /^\s*task\s+(\d+)/i.exec(t.subject ?? "");
    return match ? Number(match[1]) : null;
  });
  const numbered = numbers.filter((n) => n !== null);
  const useSubjects = numbered.length >= Math.ceil(tasks.length / 2);
  const numberAt = (i) => (useSubjects && numbers[i] !== null ? numbers[i] : i + 1);

  const active = tasks.findIndex((t) => t.status === "in_progress");
  const doneIndexes = tasks.map((t, i) => (t.status === "completed" ? i : -1)).filter((i) => i >= 0);

  const current =
    active >= 0 ? numberAt(active) : doneIndexes.length ? Math.max(...doneIndexes.map(numberAt)) : 0;
  const total = useSubjects ? Math.max(...numbered) : tasks.length;

  return { current, total: Math.max(current, total) };
}

/**
 * Task progress for a session, from the per-task JSON files Claude Code keeps
 * in ~/.claude/tasks/<session id>/. Returns null when a session isn't using
 * tasks at all, so the button can stay clean rather than showing "0/0".
 */
async function readTaskProgress(sessionId) {
  const dir = join(TASKS_DIR, sessionId);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  // Task files are named by numeric id; sort numerically so list position
  // matches the order they were created in, not "10" before "2".
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const tasks = [];
  for (const name of names) {
    try {
      tasks.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // mid-write — skip
    }
  }
  if (tasks.length === 0) return null;

  return { ...taskCounter(tasks), active: tasks.find((t) => t.status === "in_progress")?.subject ?? null };
}

/**
 * Context usage for a session, as a percentage of that model's window.
 *
 * Claude Code keeps this number to itself — it isn't in the registry or the
 * transcript — but it hands it to the status line on every render, so
 * ~/.claude/statusline-command.sh drops it here for us. Returns null when the
 * status line hasn't written for this session (or isn't installed), which
 * simply leaves the gauge off that key.
 *
 * A stale file is fine: context can't change while a session sits idle, and an
 * active session rewrites this on every render.
 */
async function readContext(sessionId) {
  try {
    const { context } = JSON.parse(await readFile(join(CTX_DIR, `${sessionId}.json`), "utf8"));
    return typeof context === "number" ? context : null;
  } catch {
    return null;
  }
}

/**
 * Live local sessions: interactive, process still running, and working in a
 * folder some open VS Code window has in its workspace.
 *
 * State comes from the registry's own `status` field rather than being
 * inferred from hooks — it distinguishes "waiting" and "requires_action"
 * (blocked on you) from plain "busy", which guessing from hook events can't.
 * One narrow exception: an "idle" session whose last turn ended right after
 * an auto-mode permission denial is promoted to "requires_action" too — see
 * `readTranscriptSignals`'s `blockedOnDenial`. The registry reports that
 * exact case as a plain completed turn, same as any other idle session, so
 * without this a session that just asked you for a permission rule reads on
 * the deck as no different from one that's simply caught up.
 *
 * A session whose cwd is nested inside — but not equal to — the matched
 * window's folder (a background worktree checkout) is flagged `nested:
 * true`; index.mjs keeps those off the board's own slots.
 */
export async function getLiveSessions() {
  const [registry, locks] = await Promise.all([readJsonFiles(SESSIONS_DIR), readJsonFiles(IDE_DIR, [".lock"])]);

  // Locks aren't only VS Code's — JetBrains IDEs write the same file with
  // their own `ideName`. Keep that per folder so a press focuses the IDE the
  // session actually lives in. Two IDEs on one folder: last lock wins.
  const ideByFolder = new Map();
  for (const l of locks) {
    for (const f of l.workspaceFolders ?? []) ideByFolder.set(f, l.ideName ?? null);
  }
  const folders = [...ideByFolder.keys()];

  const matched = [];
  for (const s of registry) {
    if (s.kind !== "interactive" || !s.sessionId || !s.cwd || !s.pid) continue;
    if (!isAlive(s.pid)) continue;
    const match = matchFolder(s.cwd, folders);
    if (!match) continue; // no live local VS Code window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder: match.folder,
      ide: ideByFolder.get(match.folder) ?? null,
      nested: match.nested,
      name: s.name ?? null,
      state: s.status ?? "idle",
      ts: Math.floor((s.statusUpdatedAt ?? s.updatedAt ?? 0) / 1000),
    });
  }

  return Promise.all(
    matched.map(async (s) => {
      const { blockedOnDenial, ...signals } = await readTranscriptSignals(
        transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id })
      );
      return {
        ...s,
        ...signals,
        state: s.state === "idle" && blockedOnDenial ? "requires_action" : s.state,
        progress: await readTaskProgress(s.session_id),
        context: await readContext(s.session_id),
      };
    })
  );
}
