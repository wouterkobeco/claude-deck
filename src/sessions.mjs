import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const IDE_DIR = join(CLAUDE_DIR, "ide");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const TASKS_DIR = join(CLAUDE_DIR, "tasks");
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

/**
 * Claude Code writes an `aiTitle` field (an AI-generated summary, the same
 * string VS Code's terminal list shows) onto transcript lines repeatedly as
 * a session progresses. Reading the whole transcript to find the latest one
 * doesn't scale, so this reads only the last chunk of the file and scans
 * backwards for the most recent occurrence.
 */
async function readLatestAiTitle(transcriptPath) {
  let fh;
  try {
    fh = await open(transcriptPath, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - TITLE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read({ buffer, position: start });
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes("aiTitle")) continue;
      try {
        const obj = JSON.parse(lines[i]);
        if (typeof obj.aiTitle === "string" && obj.aiTitle) return obj.aiTitle;
      } catch {
        // truncated line at the start of the tail slice — keep scanning
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Task progress for a session, from the per-task JSON files Claude Code keeps
 * in ~/.claude/tasks/<session id>/. Returns null when a session isn't using
 * tasks at all, so the button can stay clean rather than showing "0/0".
 */
async function readTaskProgress(sessionId) {
  const tasks = await readJsonFiles(join(TASKS_DIR, sessionId));
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.find((t) => t.status === "in_progress") ?? null;
  return { done, total: tasks.length, active: active?.subject ?? null };
}

/**
 * Live local sessions: interactive, process still running, and working in a
 * folder some open VS Code window has in its workspace.
 *
 * State comes from the registry's own `status` field rather than being
 * inferred from hooks — it distinguishes "waiting" and "requires_action"
 * (blocked on you) from plain "busy", which guessing from hook events can't.
 */
export async function getLiveSessions() {
  const [registry, locks] = await Promise.all([readJsonFiles(SESSIONS_DIR), readJsonFiles(IDE_DIR, [".lock"])]);

  const folders = locks.flatMap((l) => l.workspaceFolders ?? []);

  const matched = [];
  for (const s of registry) {
    if (s.kind !== "interactive" || !s.sessionId || !s.cwd || !s.pid) continue;
    if (!isAlive(s.pid)) continue;
    const folder = folders.find((f) => isUnder(s.cwd, f));
    if (!folder) continue; // no live local VS Code window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder,
      name: s.name ?? null,
      state: s.status ?? "idle",
      ts: Math.floor((s.statusUpdatedAt ?? s.updatedAt ?? 0) / 1000),
    });
  }

  return Promise.all(
    matched.map(async (s) => ({
      ...s,
      aiTitle: await readLatestAiTitle(transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id })),
      progress: await readTaskProgress(s.session_id),
    }))
  );
}
