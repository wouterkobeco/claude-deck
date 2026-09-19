// Codex sessions, in the shape sessions.mjs hands the board.
//
// Codex keeps no registry of running sessions the way ~/.claude/sessions is
// one, but every running `codex` process holds its rollout open for writing:
// the TUI, a `codex exec` run, the VS Code extension's app-server, and each
// thread-spawned subagent's own file. So `lsof` on processes named codex *is*
// the registry, with the pid that terminal focus needs already attached. A
// closed rollout is a finished session — the same test `isAlive` makes for a
// Claude pid.
//
// A remote host has no lsof to rely on, so its listing is `/proc/*/fd`,
// read inside the tree fetch (remote-fs.mjs), and it hands this module the
// same four things the local defaults below provide: which rollouts are open,
// each one's header, its tail, and the thread-name index.
import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const CODEX_DIR = join(homedir(), ".codex");

/** `lsof -Fpn` output -> one `{ pid, path }` per open rollout, first opener wins. */
export function parseLsof(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && /\/\.codex\/sessions\/.*\/rollout-[^/]*\.jsonl$/.test(line) && !out.has(line.slice(1)))
      out.set(line.slice(1), pid);
  }
  return [...out].map(([path, pid]) => ({ pid, path }));
}

async function openRollouts() {
  try {
    // `-c codex` matches the command name, so the ChatGPT app's helpers
    // ("Codex (Renderer)", ...) are left out; lsof exits 1 when nothing
    // matched, which is the ordinary no-Codex case.
    const { stdout } = await run("lsof", ["-c", "codex", "-a", "-d", "0-9999", "-Fpn"], { maxBuffer: 16 << 20 });
    return parseLsof(stdout);
  } catch (err) {
    return err.stdout ? parseLsof(err.stdout) : [];
  }
}

// The header line carries base instructions and runs to ~22KB; 256KB is room
// for a much longer one, and for the first turn's `turn_context` behind it —
// the model when a long turn has pushed every later one out of the tail.
export const HEAD_BYTES = 262144;

async function readHeader(path) {
  let fh;
  try {
    fh = await open(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read({ buffer, position: 0 });
    return parseHeader(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** A rollout's first `HEAD_BYTES` -> its session_meta payload plus the first turn_context, or null. */
export function parseHeader(text) {
  try {
    const lines = text.split("\n");
    const obj = JSON.parse(lines[0]);
    if (obj.type !== "session_meta") return null;
    let turn = null;
    for (const line of lines.slice(1)) {
      try {
        const o = JSON.parse(line);
        if (o?.type === "turn_context") turn = o.payload;
      } catch {}
    }
    return { ...obj.payload, firstTurn: turn };
  } catch {
    return null;
  }
}

/** `session_index.jsonl`'s text -> thread id -> name. Later lines rename. */
export function threadNames(text) {
  const names = new Map();
  for (const line of (text ?? "").split("\n")) {
    try {
      const { id, thread_name } = JSON.parse(line);
      if (id && thread_name) names.set(id, thread_name);
    } catch {}
  }
  return names;
}

// This machine's Codex, for a source that brings none of its own.
const localCodex = {
  rollouts: openRollouts,
  header: readHeader,
  index: () => readFile(join(CODEX_DIR, "session_index.jsonl"), "utf8").catch(() => ""),
};

// A prompt the human typed, not context Codex injected ahead of it (AGENTS.md,
// the environment block). The metadata says which; a rollout from before it
// existed falls back to the injected blocks' own openings.
function promptText(p) {
  if (p?.type !== "message" || p.role !== "user") return null;
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const text = (p.content ?? []).map((c) => c?.text ?? "").join("\n").trim();
  if (!text) return null;
  if (kinds) return kinds.includes("user.text") ? text : null;
  return text.startsWith("<") || text.startsWith("# AGENTS.md") ? null : text;
}

// Model and effort ride `turn_context`, which a busy turn's tool output can
// push out of the tail; the last one seen is kept per rollout.
const lastContext = new Map();

/**
 * What a rollout's tail says, in readTranscriptSignals' vocabulary. Only the
 * line's own parsed JSON is believed — a tool output can quote any rollout
 * verbatim, and its text is inside `payload.output`, never a top-level type.
 *
 * State is the last `task_started`/`task_complete`: between the two a turn is
 * running. Neither in a tail that isn't the whole file means a turn has
 * written more than the tail since starting (task_complete is a turn's last
 * line, and nothing is written after it), so it is still going. Codex writes
 * no event when it stops for an approval, so a Codex key never reads blocked
 * on you — it reads working, which is what the rollout can say.
 */
export function rolloutSignals(lines, whole, path = null) {
  let state = null,
    ts = null,
    lastPrompt = null,
    context = null,
    rate = null,
    model = null,
    effort = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const p = o?.payload;
    if (o?.type === "event_msg" && (p?.type === "task_started" || p?.type === "task_complete") && state === null) {
      state = p.type === "task_started" ? "busy" : "idle";
      ts = Math.floor(Date.parse(o.timestamp) / 1000) || null;
    } else if (o?.type === "event_msg" && p?.type === "token_count" && context === null && p.info) {
      const used = p.info.last_token_usage?.input_tokens;
      const window = p.info.model_context_window;
      if (typeof used === "number" && window) context = Math.min(100, Math.round((used / window) * 100));
      rate ??= p.rate_limits ?? null;
    } else if (o?.type === "event_msg" && p?.type === "token_count") {
      rate ??= p.rate_limits ?? null;
    } else if (o?.type === "turn_context" && model === null) {
      model = p?.model ?? null;
      effort = p?.effort ?? p?.reasoning_effort ?? null;
    } else if (o?.type === "response_item" && lastPrompt === null) {
      lastPrompt = promptText(p);
    }
    if (state && context !== null && rate && model && lastPrompt) break;
  }
  if (path && model) lastContext.set(path, { model, effort });
  const kept = path ? lastContext.get(path) : null;
  return {
    state: state ?? (whole ? "idle" : "busy"),
    ts,
    lastPrompt: lastPrompt ? lastPrompt.slice(0, 500) : null,
    context,
    rate,
    model: model ?? kept?.model ?? null,
    effort: model ? effort : (kept?.effort ?? null),
  };
}

/**
 * Codex's `rate_limits` -> the status line's shape (`five_hour`/`seven_day`,
 * `used_percentage`, `resets_at` in epoch seconds), so `remoteUsage` reads
 * both. Codex names its windows primary/secondary and says which is which by
 * length, not by name.
 */
export function codexRate(r) {
  const out = {};
  for (const w of [r?.primary, r?.secondary]) {
    if (typeof w?.used_percent !== "number") continue;
    const key = w.window_minutes === 300 ? "five_hour" : w.window_minutes === 10080 ? "seven_day" : null;
    if (key) out[key] = { used_percentage: w.used_percent, resets_at: w.resets_at ?? null };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Every live Codex session under a VS Code window's folder (`matchFolder`,
 * passed in rather than imported, to keep this module off sessions.mjs's
 * import graph). Nested exactly when something else spawned it: a
 * thread-spawned subagent names its parent thread, and a `codex exec` run's
 * parent is found in its pid ancestry by the caller, the way an SDK
 * session's is — the ship-review skill's runs land on the Claude key that
 * started them. A subagent shows only while it works, like Claude's own.
 */
export async function codexSessions({ folders, ideByFolder, matchFolder, tail, codex = localCodex, host = null, root = CODEX_DIR }) {
  const rollouts = await codex.rollouts();
  if (!rollouts.length) return [];
  const names = threadNames(await codex.index());
  tail = codex.tail ?? tail;
  const out = await Promise.all(
    rollouts.map(async ({ pid, path }) => {
      const meta = await codex.header(path);
      if (!meta?.id || !meta.cwd) return null;
      const match = matchFolder(meta.cwd, folders);
      if (!match) return null;
      const spawnedBy = meta.source?.subagent?.thread_spawn?.parent_thread_id ?? meta.parent_thread_id ?? null;
      const exec = meta.originator === "codex_exec";
      const { lines, whole } = await tail(path);
      const sig = rolloutSignals(lines, whole, path);
      if (spawnedBy && sig.state !== "busy") return null;
      const aiTitle = names.get(meta.id) ?? null;
      return {
        session_id: meta.id,
        agent: "codex",
        transcript: path,
        cwd: meta.cwd,
        folder: match.folder,
        pid,
        cmux: null,
        ide: ideByFolder.get(match.folder) ?? null,
        nested: !!spawnedBy || exec,
        ...(spawnedBy ? { parent: spawnedBy, subagent: true } : {}),
        name: spawnedBy ? (meta.agent_nickname ?? meta.agent_role ?? "subagent") : null,
        state: sig.state,
        ts: sig.ts ?? Math.floor(Date.parse(meta.timestamp) / 1000),
        host,
        root,
        aiTitle,
        lastPrompt: sig.lastPrompt,
        clearedEmpty: false,
        // A session nobody has spoken to reads CLEAR, same rule as Claude's.
        startedEmpty: whole && !sig.lastPrompt && !aiTitle,
        model: sig.model ?? meta.firstTurn?.model ?? null,
        effort: sig.model ? sig.effort : (meta.firstTurn?.effort ?? meta.firstTurn?.reasoning_effort ?? null),
        context: sig.context,
        progress: null,
        rateLimits: codexRate(sig.rate),
      };
    })
  );
  return out.filter(Boolean);
}
