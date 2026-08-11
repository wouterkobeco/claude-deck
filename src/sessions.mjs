import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_DIR = join(homedir(), ".claude", "session-status");
const IDE_DIR = join(homedir(), ".claude", "ide");
const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
const STALE_SECONDS = 6 * 60 * 60; // see docs/superpowers/specs — deliberately long, not a recency filter

async function readJsonFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of names) {
    if (!name.endsWith(".json") && !name.endsWith(".lock")) continue;
    try {
      results.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // partial write or corrupt file — skip it, not a crash
    }
  }
  return results;
}

function isUnder(cwd, folder) {
  return cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : folder + "/");
}

/**
 * Live local sessions: have a fresh status file AND a cwd that falls under
 * some open VS Code workspace folder (i.e. a real local IDE window exists).
 * Returns sessions sorted most-recently-active first, each annotated with
 * the workspace folder it matched (used for `code -r`) and, where available,
 * the human-readable session name Claude Code itself assigns (the one shown
 * in VS Code's terminal list) — pulled from its own session registry, not
 * derived from the worktree path, since the two can differ.
 */
export async function getLiveSessions() {
  const [statuses, locks, registry] = await Promise.all([
    readJsonFiles(STATUS_DIR),
    readJsonFiles(IDE_DIR),
    readJsonFiles(SESSIONS_DIR),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const folders = locks.flatMap((l) => l.workspaceFolders ?? []);
  const namesById = new Map(registry.filter((r) => r.sessionId && r.name).map((r) => [r.sessionId, r.name]));

  const sessions = [];
  for (const s of statuses) {
    if (!s.session_id || !s.cwd || !s.state || !s.ts) continue;
    if (now - s.ts > STALE_SECONDS) continue;
    const folder = folders.find((f) => isUnder(s.cwd, f));
    if (!folder) continue; // no live local IDE window for this session
    sessions.push({ ...s, folder, name: namesById.get(s.session_id) ?? null });
  }

  sessions.sort((a, b) => b.ts - a.ts);
  return sessions;
}
