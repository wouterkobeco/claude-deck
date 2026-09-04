import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLedgerTasks } from "./sdd-ledger.mjs";
import { ancestorChain, psTable } from "./terminal-focus.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
// cmux (a terminal app that drives Claude Code sessions of its own) keeps its
// own live registry here, fed by hooks it installs — the same role an IDE's
// `.lock` file plays, in a different shape. It is macOS-local state, not part
// of any ssh-fetched tree, so only the local source ever points at it.
const CMUX_SESSIONS_PATH = join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
const TAIL_BYTES = 65536;
// How long a subagent transcript can sit unwritten before the agent is assumed
// gone. An agent that was interrupted never writes its `end_turn`, so without
// this its marker would stay on the key forever; it also keeps the tail reads
// below to the handful of files that could still be live.
const SUBAGENT_IDLE_MAX_S = 600;
// How long after a `/compact` command line the session can still be assumed
// to be compacting. Real compactions run 70-120s; the cap is what stops a
// canceled `/compact` (which leaves the command line with nothing after it)
// from spinning forever if the status flip doesn't clear it first.
const COMPACT_MAX_S = 180;

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

// Exported for window-state.mjs, which needs the same test on a different kind
// of pid — a VS Code extension host rather than a Claude process. One
// definition rather than two: signal 0 meaning "does this pid exist" is the
// kind of detail that gets re-derived subtly wrong.
export function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code stores a session's transcript under a directory named after its
 * cwd, with every character outside [a-zA-Z0-9] flattened to `-`.
 *
 * It is the full class, not just `/` and `.`: a worktree named `feat+thing`
 * lands in `-…-worktrees-feat-thing`, and encoding only the two obvious
 * characters aimed us at a path that doesn't exist. That failure is silent by
 * design — every read here is try/catch — so those sessions simply lost their
 * title, model tile and blocked/compacting detection with nothing to show for
 * it.
 */
export function transcriptPathFor({ cwd, sessionId }, root = CLAUDE_DIR) {
  return join(projectDirFor(cwd, root), `${sessionId}.jsonl`);
}

/**
 * Where an Agent-tool subagent's own transcript sits — `readRunningSubagents`
 * reads this directory already, this just names one file in it for a caller
 * that wants that agent's own usage rather than its stop_reason.
 */
export function subagentTranscriptPath({ cwd, parent, agentId }, root = CLAUDE_DIR) {
  return join(projectDirFor(cwd, root), parent, "subagents", `agent-${agentId}.jsonl`);
}

/**
 * The directory name Claude Code files a cwd's transcripts under: every
 * non-alphanumeric character replaced by a dash.
 *
 * Exported because moving a session between machines has to reproduce it
 * exactly for the *destination* path — `claude --resume` finds a session by
 * looking in the current directory's own slug and nowhere else (measured: the
 * same transcript under a non-matching slug answers "No conversation found").
 * One copy of the rule, so a transfer can never file a session somewhere
 * resume won't look.
 */
export function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectDirFor(cwd, root = CLAUDE_DIR) {
  return join(root, "projects", projectSlug(cwd));
}

/**
 * The last `TAIL_BYTES` of a transcript, split into lines, newest last. These
 * files run to megabytes and everything read from them is near the end.
 * Returns no lines rather than throwing: they're written by another process and
 * a poll can land mid-write, or the file can be gone by the time we open it.
 * The first line is likely a fragment — every caller parses per line and skips
 * what won't parse.
 *
 * `whole` says the window reached byte 0, so absence in `lines` is absence in
 * the file. Every other signal here is found by scanning backwards and stops at
 * the first hit, which the tail can only ever help; "nothing said in this
 * session yet" is the one that needs to know it saw everything. A read that
 * failed reports `false` — unknown, not empty.
 */
export async function tailLines(path) {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read({ buffer, position: start });
    return { lines: buffer.subarray(0, bytesRead).toString("utf8").split("\n"), whole: start === 0 };
  } catch {
    return { lines: [], whole: false };
  } finally {
    await fh?.close();
  }
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

// How much of a prompt is worth carrying. renderKey wraps and ellipsizes on its
// own, so this isn't the display limit — it's so a key's diffing signature (and
// the published session list) doesn't hold a pasted stack trace.
const PROMPT_MAX = 120;

/**
 * The human's typed prompt, as a key body.
 *
 * A slash command is stored as its own markup rather than what you typed
 * (`<command-message>foo</command-message><command-name>/foo</command-name>`),
 * so the command name is pulled out and everything else dropped — the tags
 * would otherwise fill the key with angle brackets. Anything else is taken as
 * written, with newlines flattened: a body is 3-4 wrapped lines and a pasted
 * paragraph's own line breaks say nothing at that size.
 *
 * Not exported; `readTranscriptSignals`'s own return is what title-check reads,
 * so there's one surface to check rather than two.
 */
function promptText(content) {
  // The tags come in either order (`<command-message>` first for a project
  // command, `<command-name>` first for a builtin), so the name is matched
  // anywhere — but only inside content that *is* this markup, never content
  // that merely quotes a tag somewhere in a sentence.
  if (content.startsWith("<")) {
    const command = content.match(/<command-name>([^<]*)<\/command-name>/);
    // Every other kind of markup here is Claude Code talking to itself on the
    // user's turn and is not always flagged `isMeta` — a `<task-notification>`
    // for a finished background agent isn't, and put its tags on a key. Null
    // rather than a guess: the scan keeps walking back to something typed.
    if (!command) return null;
    const args = content.match(/<command-args>([^<]*)<\/command-args>/)?.[1];
    return [command[1], args].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, PROMPT_MAX) || null;
  }
  const flat = content.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, PROMPT_MAX) : null;
}

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
 * `startedEmpty` — the same "nothing to say yet", reached the other way: a
 * session opened and not yet typed into. Claude Code writes a transcript the
 * moment the session starts (a mode line, a snapshot, any SessionStart hook
 * output, all `type:"attachment"`), so the file existing says nothing; the
 * first `type:"user"` line is the human's first prompt. Requires `whole`,
 * because "no user line in the tail" is otherwise just as true of a session
 * whose last 64KB happen to be one long tool-calling stretch.
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
 *
 * `pendingTool` — the same idea as `blockedOnDenial`, for the two tools that
 * pause a turn on a human decision rather than a permission rule:
 * `ExitPlanMode` (plan approval) and `AskUserQuestion`. It's `"plan"` /
 * `"question"` / `null`, decided by whichever comes first scanning backward,
 * a `type:"user"` line or a `type:"assistant"` one — the newest conversational
 * line either way. A user line means it was already answered (approved,
 * rejected, or the turn moved on); an assistant line whose `stop_reason` is
 * `tool_use` and whose newest call is one of these two tools means nothing
 * has replied to it yet. Deliberately promoted the same way `blockedOnDenial`
 * is rather than getting its own board state: whether it's a denied
 * permission or an unanswered plan, the key needs your attention either way,
 * and the registry's own `status` may already say so for these — this only
 * ever fires on a session that's otherwise reading `idle`.
 */
export async function readTranscriptSignals(transcriptPath, tail = tailLines) {
  try {
    const { lines, whole } = await tail(transcriptPath);

    let aiTitle = null,
      clearedEmpty = false,
      titleResolved = false;
    let blockedOnDenial = false,
      denialResolved = false;
    let pendingTool = null,
      stopReason = null,
      pendingResolved = false;
    let lastPrompt = null,
      promptResolved = false;
    let model = null,
      effort = null,
      contextEstimate = null,
      modelResolved = false;

    // `compactRequestedAt` — the timestamp of the newest `type:"user"` line
    // when that line is a `/compact` command with nothing from the
    // conversation after it. Running `/compact` writes its command line
    // immediately, then the transcript goes quiet until the boundary — so
    // this is a direct start marker, not an inference. When compaction
    // finishes (or is canceled and the conversation resumes), a newer user
    // line exists and the signal clears itself. An earlier version inferred
    // compaction from transcript *silence* instead; a turn thinking for 25s+
    // writes nothing either, so busy sessions kept false-firing.
    let compactRequestedAt = null;

    for (
      let i = lines.length - 1;
      i >= 0 && (!titleResolved || !denialResolved || !pendingResolved || !modelResolved || !promptResolved);
      i--
    ) {
      const line = lines[i];
      // Every marker below is a substring *pre-filter* only — cheap enough to
      // run down a megabyte of tail — and nothing is believed until this
      // line's own JSON says so. A transcript carries tool results verbatim,
      // so any of these strings can appear inside content that is not the
      // thing it marks: a session that greps this very file, or prints
      // another transcript, writes `<command-name>/clear</command-name>`,
      // `toolDenialKind` and `"type":"user"` into its own tail as *text*.
      // That's not hypothetical — it blanked this project's own key.
      // Parsed once, lazily, and shared by all three branches.
      let obj;
      let parsed = false;
      const parse = () => {
        if (!parsed) {
          parsed = true;
          try {
            obj = JSON.parse(line);
          } catch {
            obj = null; // truncated line at the start of the tail slice
          }
        }
        return obj;
      };
      // A line's own top-level type, never a substring: `"type":"user"` inside
      // a tool result would otherwise end the newest-user-line scan on a line
      // that isn't one.
      const typeIs = (t) => parse()?.type === t;
      // Slash commands are written as an ordinary user line whose content
      // *starts* with the command tag (both formats Claude Code writes).
      // Content that merely contains one is a quote of it.
      const isCommand = (name) => {
        const content = parse()?.message?.content;
        return (
          content === name ||
          (typeof content === "string" && content.startsWith(`<command-name>${name}</command-name>`))
        );
      };

      if (!titleResolved) {
        if (line.includes("aiTitle")) {
          const o = parse();
          if (typeof o?.aiTitle === "string" && o.aiTitle) {
            aiTitle = o.aiTitle;
            titleResolved = true;
          }
        }
        if (!titleResolved && line.includes(CLEAR_MARKER) && typeIs("user") && isCommand("/clear")) {
          clearedEmpty = true;
          titleResolved = true;
        }
      }

      if ((!denialResolved || !promptResolved) && line.includes(USER_LINE_MARKER) && typeIs("user")) {
        if (!denialResolved) {
          // A top-level field of this line, not a string somewhere in it.
          blockedOnDenial = parse().toolDenialKind !== undefined;
          // The same newest-user-line decides compacting: /compact writes its
          // command line immediately and then goes quiet, so the line is the
          // start marker.
          if (isCommand("/compact")) {
            const t = Date.parse(parse().timestamp);
            if (Number.isFinite(t)) compactRequestedAt = t;
          }
          denialResolved = true;
        }
        // Most user lines are not the human: a tool result rides on the user
        // turn (its content is an array of blocks), and Claude Code injects its
        // own — skill bodies, command output, the local-command caveat — marked
        // `isMeta`. What the human typed is a plain *string* content on a line
        // that isn't meta, which is also true of a slash command, whose tags
        // promptText unwraps. Newest wins, so this stops at the first one going
        // backwards — which is also why a `/clear` needs no special case: the
        // /clear line is itself one of these, so the search can never reach
        // past it into the conversation it threw away.
        if (!promptResolved) {
          const content = parse().message?.content;
          // Resolved only on a line that yielded something: promptText returns
          // null for markup and for whitespace, and those must let an older
          // prompt through rather than ending the search on nothing.
          if (typeof content === "string" && !parse().isMeta) lastPrompt = promptText(content);
          if (lastPrompt) promptResolved = true;
        }
      }

      // pendingTool: whichever of a user line or an assistant line is newest
      // decides it. A user line means the turn was already answered, however
      // long ago — so this must resolve on the very first line of either kind
      // encountered going backward, not just the first assistant one.
      if (!pendingResolved && (line.includes(USER_LINE_MARKER) || line.includes('"type":"assistant"'))) {
        if (typeIs("user")) {
          pendingResolved = true;
        } else if (typeIs("assistant")) {
          const o = parse();
          // The newest turn's own ending, kept for a session whose registry
          // entry carries no `status` — see `liveState`. Null when the newest
          // line of either kind is a user line, which is its own answer there.
          stopReason = o.message?.stop_reason ?? null;
          if (o.message?.stop_reason === "tool_use") {
            const call = (o.message.content ?? []).find(
              (b) => b?.type === "tool_use" && (b.name === "ExitPlanMode" || b.name === "AskUserQuestion")
            );
            if (call) pendingTool = call.name === "ExitPlanMode" ? "plan" : "question";
          }
          pendingResolved = true;
        }
      }

      // Model and effort ride on assistant lines; the newest one is what the
      // session is running right now. Same scan, no extra read.
      if (!modelResolved && line.includes('"type":"assistant"') && typeIs("assistant")) {
        const o = parse();
        // Claude Code writes its own interrupt and API-error entries as
        // assistant lines claiming `model: "<synthetic>"`. Those are the
        // moments you're most likely to be looking at the deck, and the tile
        // would read "<synthetic>" — keep scanning back for a real turn.
        if (o.message?.model && o.message.model !== "<synthetic>") {
          model = o.message.model;
          effort = o.effort ?? null;
          // That same line carries the usage the context gauge falls back to
          // when no status line wrote a ctx file. Same scan, no extra read.
          contextEstimate = contextPercent(o.message.usage, model);
          modelResolved = true;
        }
      }
    }

    // `denialResolved` is set exactly when the scan met a `type:"user"` line,
    // so it doubles as "the human has said something". The aiTitle and
    // clearedEmpty guards are belt-and-braces — neither can exist without a
    // user line ahead of it — so this can only ever blank a key that has
    // nothing else to draw.
    const startedEmpty = whole && !denialResolved && !aiTitle && !clearedEmpty;

    return {
      aiTitle,
      lastPrompt,
      clearedEmpty,
      startedEmpty,
      blockedOnDenial,
      pendingTool,
      stopReason,
      model,
      effort,
      contextEstimate,
      compactRequestedAt,
    };
  } catch {
    return {
      aiTitle: null,
      lastPrompt: null,
      clearedEmpty: false,
      startedEmpty: false,
      blockedOnDenial: false,
      pendingTool: null,
      stopReason: null,
      model: null,
      effort: null,
      contextEstimate: null,
      compactRequestedAt: null,
    };
  }
}

/**
 * When each of a session's agents last *stopped*, by agent id, from the
 * `<task-notification>` its parent records.
 *
 * The reason this exists: `stop_reason: "end_turn"` has largely stopped being
 * written. Measured over the 1528 subagent transcripts on this machine, the
 * share of agents that never write one goes 2% at Claude Code 2.1.228, 13% at
 * 2.1.238, then 73% at 2.1.243 and 68–93% after — which is where background
 * subagents became the default, and a background agent doesn't end a turn, it
 * *stops* and stays resumable. So the old rule left a finished agent showing
 * as running until `SUBAGENT_IDLE_MAX_S` retired it ten minutes later, with
 * the parent's key painted busy by `mostUrgent` for all of it. Caught in the
 * act: an agent that wrote its last line at 16:49 was still on the board at
 * 16:58.
 *
 * The notification is exact and it is complete: of the 60 most recent agents
 * here, 60 have one (58 `completed`, 2 `failed`), including all 44 that never
 * wrote `end_turn`. Status is not read — the notification fires *because* the
 * agent stopped, and both statuses mean the same thing to a marker.
 *
 * A stop time is compared against the agent transcript's mtime rather than
 * trusted outright, because the notification says so itself: "the same task-id
 * may notify more than once" — a resumed agent writes again, and a file newer
 * than its last notification is an agent that is running again.
 *
 * `<task-notification>` is a *pre-filter* on the raw line and nothing more:
 * the content is then taken from this line's own parsed JSON, and only when it
 * is a string that starts with the tag. An agent quoting a notification back
 * (they do — that is how one reports what it was told) arrives as a content
 * array, not a string.
 */
async function readAgentStops(parentPath, tail) {
  const stops = new Map();
  if (!parentPath) return stops;
  const { lines } = await tail(parentPath).catch(() => ({ lines: [] }));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("<task-notification>")) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue; // truncated line at the start of the tail slice
    }
    const content = o?.message?.content;
    if (o.type !== "user" || typeof content !== "string" || !content.startsWith("<task-notification>")) continue;
    const id = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1];
    const at = Date.parse(o.timestamp);
    // Scanning backwards, so the first sighting of an id is its newest.
    if (id && Number.isFinite(at) && !stops.has(id)) stops.set(id, at);
  }
  return stops;
}

/**
 * The subagents a session has running right now.
 *
 * An Agent-tool subagent — the thing behind "Waiting for 1 background agent to
 * finish" — never registers in ~/.claude/sessions: it runs inside its parent's
 * process, and exists on disk only as a transcript under the parent's own
 * `<session id>/subagents/` directory. So the entrypoint rule in
 * `getLiveSessions` can't see it; that one only finds *SDK* sessions, which
 * are separate processes with registry entries of their own.
 *
 * Running is read from the newest `stop_reason` in that transcript, which is
 * an exact marker rather than a guess: an agent waiting on a tool last stopped
 * for "tool_use", and one that has handed its result back ends "end_turn" and
 * writes nothing further. A just-spawned agent has no stop_reason yet and
 * counts as running — its mtime is seconds old, and `SUBAGENT_IDLE_MAX_S` is
 * what retires the other no-ending case, an agent interrupted mid-tool.
 *
 * Takes the directory rather than a session so the check can point it at a
 * fixture. Every read is try/catch-skipped, same as everything else here.
 */
export async function readRunningSubagents(dir, tail = tailLines, parentPath = null) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return []; // no subagents dir — this session has never spawned one
  }
  if (!names.length) return [];

  // One extra tail read, and only for a session that has agents on disk at
  // all — the poll pays for it exactly where it buys something.
  const stopped = await readAgentStops(parentPath, tail);

  const running = [];
  for (const name of names) {
    const path = join(dir, name);
    let mtimeMs;
    try {
      ({ mtimeMs } = await stat(path));
    } catch {
      continue; // vanished between readdir and stat
    }
    if ((Date.now() - mtimeMs) / 1000 > SUBAGENT_IDLE_MAX_S) continue;

    // A source-supplied tail (ssh-backed) can reject mid-poll; every other
    // read here is try/catch-skipped and this one has to be too, or one bad
    // read takes the whole board down through sessionsFrom's Promise.all.
    const { lines } = await tail(path).catch(() => ({ lines: [] }));
    let stopReason = null;
    // The agent's own working directory, which is not always its parent's: an
    // SDD controller dispatches into the worktree its plan lives in, and that
    // path is the only way the parent's key can find the ledger. Every line
    // carries it, so the newest one that parses answers it.
    let cwd = null;
    for (let i = lines.length - 1; i >= 0 && (stopReason === null || cwd === null); i--) {
      // Parse before trusting: "stop_reason" appears inside tool results and
      // prose all the time, which is exactly the trap the /compact marker fell
      // into. Only this line's own message counts.
      if (cwd !== null && !lines[i].includes("stop_reason")) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (cwd === null && typeof o.cwd === "string") cwd = o.cwd;
        if (stopReason === null) stopReason = o.message?.stop_reason ?? null;
      } catch {
        // truncated line at the start of the tail slice — keep scanning
      }
    }
    // Stopped, said so in the parent, and has written nothing since. This is
    // the exact signal; `end_turn` below is what is left when the tail didn't
    // reach the notification.
    if (stopped.get(name.replace(/^agent-|\.jsonl$/g, "")) >= mtimeMs) continue;
    if (stopReason === "end_turn") continue;

    let description = null;
    try {
      ({ description = null } = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8")));
    } catch {
      // no meta yet, or mid-write — the tile falls back to the agent id
    }
    running.push({ id: name.replace(/^agent-|\.jsonl$/g, ""), description, cwd, ts: Math.floor(mtimeMs / 1000) });
  }
  return running;
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

  // Subject per task number, so a square on the web board can name its task.
  const subjects = [];
  tasks.forEach((t, i) => (subjects[numberAt(i) - 1] = t.subject ?? ""));
  return { current, total: Math.max(current, total), subjects };
}

/**
 * Every task for a session, in creation order. Task files are named by
 * numeric id, so they're sorted numerically — "10" after "2", not before it.
 * Returns [] for a session that isn't using tasks, and skips any file caught
 * mid-write rather than throwing.
 *
 * **`localCwd` is the fallback for a session Claude Code isn't tracking.** A
 * session driving superpowers' subagent-driven development keeps its task list
 * in a ledger in the project instead, and `~/.claude/tasks/<id>/` stays empty
 * — which showed up as a blank progress bar and an empty detail board through
 * a day of six-task work. The fallback lives *here*, at the one function both
 * the progress bar and the detail board already route through, so neither can
 * have it without the other.
 *
 * Claude Code's own tasks win when there are any: the ledger is another tool's
 * file read on a guess, and this one is the session telling us directly.
 *
 * Null for a remote session — see `readLedgerTasks`, whose `cwd` has to be a
 * path on *this* machine.
 */
export async function readTaskList(sessionId, root = CLAUDE_DIR, localCwd = null) {
  const dir = join(root, "tasks", sessionId);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return readLedgerTasks(localCwd);
  }
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const tasks = [];
  for (const name of names) {
    try {
      tasks.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      // mid-write — skip
    }
  }
  return tasks.length ? tasks : readLedgerTasks(localCwd);
}

/**
 * Give every nested session with no recorded parent the live session that
 * spawned it, found in its pid ancestry.
 *
 * Only when there is one to place, so a poll pays for the process table only
 * when it buys something — on most machines this never runs at all. A remote
 * source already carries the host's own table (`source.ppids`), which is the
 * only one whose pids mean anything over there; a remote host that gave none
 * simply keeps the old behaviour.
 */
async function attachSdkParents(matched, source) {
  const orphans = matched.filter((s) => s.nested && !s.parent);
  if (!orphans.length) return;
  const ppids = source.ppids?.size ? source.ppids : source.host ? null : await psTable().catch(() => null);
  if (!ppids?.size) return;
  const owner = new Map(matched.map((s) => [s.pid, s.session_id]));
  for (const s of orphans) {
    for (const pid of ancestorChain(s.pid, ppids)) {
      const id = owner.get(pid);
      // Nearest live session wins, and never itself: `ancestorChain` starts at
      // the process above this one, but a table read mid-poll can hold
      // anything.
      if (id && id !== s.session_id) {
        s.parent = id;
        break;
      }
    }
  }
}

/**
 * The distinct working directories of the subagents this session is running,
 * minus its own — the only cwds allowed to answer for it (see the call site).
 */
/**
 * The last directory a session's own agent was working in, by session id.
 *
 * Superpowers' SDD alternates: an Agent-tool subagent implements a task, then
 * an SDK session reviews it, and between the two the controller sits alone for
 * anything from seconds to a minute while it writes the next brief. Without
 * this the plan appears, vanishes and reappears on its key through every one
 * of those gaps — a count that blinks reads as a bug in the board, which is
 * how it read here before this existed.
 *
 * Held for the life of the session and no longer (`getLiveSessions` prunes),
 * and it is a *hint*, never an answer: the ledger at that path is re-read on
 * every poll, and the 24h staleness cap in `sdd-ledger.mjs` still decides
 * whether what it finds is progress or an abandoned plan.
 */
const workspaceMemory = new Map();

export function agentCwds(session, subagents) {
  const own = new Set();
  for (const a of subagents) {
    // `agentCwd` for a synthesised subagent (whose own `cwd` is its parent's,
    // inherited at synthesis); the plain `cwd` for an SDK session, which has a
    // registry entry and a real one of its own.
    const where = a.agentCwd ?? a.cwd;
    if (a.parent === session.session_id && where && where !== session.cwd) own.add(where);
  }
  if (own.size) workspaceMemory.set(session.session_id, [...own]);
  // Nothing running right now: the last place one was is the best guess left,
  // and a wrong one costs nothing — the ledger there has to still parse, still
  // be an SDD ledger and still be fresh.
  return own.size ? [...own] : (workspaceMemory.get(session.session_id) ?? []);
}

/**
 * Task progress for a session, from the per-task JSON files Claude Code keeps
 * in ~/.claude/tasks/<session id>/. Returns null when a session isn't using
 * tasks at all, so the button can stay clean rather than showing "0/0".
 */
async function readTaskProgress(sessionId, root, localCwd) {
  const tasks = await readTaskList(sessionId, root, localCwd);
  if (tasks.length === 0) return null;
  return { ...taskCounter(tasks), active: tasks.find((t) => t.status === "in_progress")?.subject ?? null };
}

/**
 * The `size` tasks worth showing. Centred on the in-progress one so you see
 * what's just been done and what's next, clamped at both ends so the window
 * is always full when the list is long enough to fill it. No in-progress task
 * (a finished or not-yet-started list) starts at the top.
 */
export function taskWindow(tasks, size) {
  if (tasks.length <= size) return tasks;
  const active = tasks.findIndex((t) => t.status === "in_progress");
  if (active < 0) return tasks.slice(0, size);
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), tasks.length - size));
  return tasks.slice(start, start + size);
}

/**
 * Context windows, by model id with any trailing `-YYYYMMDD` stripped.
 *
 * Only models whose window has been *measured* are in here, and the measurement
 * is one division: a transcript's prompt size ÷ the percentage Claude Code's own
 * status line reported for the same session, over every ctx file on this machine
 * (n is that count). A model that isn't listed gets no gauge rather than a
 * guessed one — this feeds a fallback, and a bar reading 40% on a session at 8%
 * is worse than no bar. Claude Code's own changelog has a fixed bug about
 * offering a 1M upgrade to a model that already had one, so "which Opus is 1M"
 * is not a thing to reason about from a name.
 *
 * A model here can only be added by measuring it: run a session on it with the
 * status line block installed, then divide. `claude-opus-4-7` and
 * `claude-sonnet-4-6` are in this machine's transcripts and deliberately absent
 * here — no ctx file survives for either, so neither has been measured.
 * (claude-deck, where this fallback came from, ships a guessed table instead;
 * its `claude-fable-5: 200_000` measures 1M here across 21 sessions.)
 */
const CONTEXT_WINDOWS = new Map([
  ["claude-opus-5", 1_000_000], // n=273, 1002k median
  ["claude-sonnet-5", 1_000_000], // n=72, 999k median
  ["claude-fable-5", 1_000_000], // n=21, 1023k median
]);

/**
 * Context percentage from one assistant turn's `message.usage`, or null.
 *
 * Every assistant line's usage describes the whole prompt that produced it, so
 * `cache_read + cache_creation + input` *is* the context in the window at that
 * moment — the cached parts are the conversation, not a discount on it. Against
 * the ctx files on this machine this reproduces Claude Code's own percentage
 * exactly, rounding included, on every session checked.
 *
 * Null for a model whose window isn't known, and for a line with no usage.
 */
export function contextPercent(usage, model) {
  if (!usage || !model) return null;
  const window = CONTEXT_WINDOWS.get(model.replace(/-\d{8}$/, ""));
  if (!window) return null;
  const used =
    (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return used > 0 ? Math.min(100, Math.round((used / window) * 100)) : null;
}

/**
 * Context usage for a session, as a percentage of that model's window.
 *
 * Claude Code hands this number to the status line on every render, so
 * ~/.claude/statusline-command.sh drops it here for us — and that file is the
 * authority, because it is measured against the window Claude Code actually
 * has rather than the table above. Returns null when the status line hasn't
 * written for this session (or isn't installed); `contextPercent` is what the
 * caller falls back to then.
 *
 * A stale file is fine: context can't change while a session sits idle, and an
 * active session rewrites this on every render.
 */
async function readContext(sessionId, root = CLAUDE_DIR) {
  try {
    const { context } = JSON.parse(await readFile(join(root, "ctx", `${sessionId}.json`), "utf8"));
    return typeof context === "number" ? context : null;
  } catch {
    return null;
  }
}

/**
 * When this session's PreCompact hook last fired, if it has and PostCompact
 * hasn't cleared it yet — see compact-hook.mjs for why this file exists at
 * all: it is the only way to see an *auto*-triggered compaction, which writes
 * nothing else anywhere until it is already over. Missing is the ordinary
 * case (no compaction running, or the hook isn't installed), not an error.
 */
async function readCompactMarker(sessionId, root = CLAUDE_DIR) {
  try {
    const { at } = JSON.parse(await readFile(join(root, "streamdeck-compact", `${sessionId}.json`), "utf8"));
    return typeof at === "number" ? { at } : null;
  } catch {
    return null;
  }
}

// A real auto-compaction measured on this machine ran 160s — already past the
// "70-120s" a manual one was timed at — so the marker's own safety net (for a
// PostCompact that never fires: an interrupted compaction, a crash) is capped
// at the hook's own default timeout instead, comfortably clear of anything a
// real one should take.
const MARKER_MAX_S = 600;

/**
 * Whether a session reads as compacting right now — the marker when it's
 * fresh (exact, and the only signal an auto-triggered compaction has at all),
 * else the manual `/compact` transcript line the way this always worked.
 * Exported and pure for the reason `statusKey`/`isRepeatPress` are: this is
 * the whole rule, and nothing outside a real compaction can exercise it.
 */
/**
 * The state of a session whose registry entry has no `status` field at all.
 *
 * Every SDK session observed writes none — `status`, `updatedAt` and
 * `statusUpdatedAt` are all absent, where a `cli` session has all three — and
 * `status ?? "idle"` therefore called a superpowers controller idle for the
 * two hours it spent working through nine tasks. That is the dishonesty this
 * project refuses: a working session must never read idle.
 *
 * The rule is `readRunningSubagents`', because it is the same question asked
 * of the same evidence: a turn that ended `end_turn` is finished and writes
 * nothing further, and anything else — a tool call outstanding, or a newest
 * line that is the user's, meaning the model is answering right now — is work
 * in flight. What that function needs and this doesn't is the idle-age cap: a
 * subagent has no pid, so an interrupted one would hang busy forever, while
 * every session here has already passed `isAlive`.
 */
export function liveState(stopReason) {
  return stopReason === "end_turn" ? "idle" : "busy";
}

export function compactingNow({ state, compactRequestedAt, marker }, now = Date.now()) {
  if (marker && (now - marker.at) / 1000 < MARKER_MAX_S) return true;
  return state === "busy" && compactRequestedAt !== null && (now - compactRequestedAt) / 1000 < COMPACT_MAX_S;
}

/**
 * The local machine as a source: today's behaviour, named.
 *
 * A source is the whole host-dependent surface of this module — where the tree
 * is, whether a pid is alive, and how a transcript tail is read. Every path here
 * derives from one root, so those three are all a remote host needs to supply;
 * everything between them is this file, unchanged, which is the point. See
 * docs/superpowers/specs/2026-08-16-remote-ssh-sessions-design.md.
 *
 * `cmuxPath` is a fourth, optional field, and deliberately not part of that
 * contract — cmux is a local macOS app with no ssh-fetched equivalent, so a
 * remote source simply has none and its sessions get no cmux fallback.
 */
export function localSource(root = CLAUDE_DIR, cmuxPath = CMUX_SESSIONS_PATH) {
  return { host: null, root, isAlive, tail: tailLines, cmuxPath };
}

/**
 * `sessionId -> surfaceId` for every session cmux currently shows in a live
 * pane, read from its own hook-fed registry. Absence (no file, unreadable,
 * cmux not running) is an empty map, not an error — most sources have no
 * `cmuxPath` at all, and even the local one is nothing unusual before cmux is
 * ever opened.
 */
async function readCmuxSurfaces(path) {
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return new Map();
  }
  const surfaces = new Map();
  for (const [surfaceId, entry] of Object.entries(data.activeSessionsBySurface ?? {})) {
    if (entry?.sessionId) surfaces.set(entry.sessionId, surfaceId);
  }
  return surfaces;
}

/**
 * Maps `sessionsFrom` over every source and flattens the result — the whole of
 * what a remote host adds at this level. A source's `isAlive`/`tail` are
 * someone else's code (ssh-backed, for a remote host), which can throw where a
 * local read would merely fail try/catch, so each call is isolated with its
 * own `.catch(() => [])`: one bad host drops only its own keys, the way a
 * closed window's would, rather than taking the whole board's Promise.all
 * down with it.
 */
export async function getLiveSessions(sources = [localSource()]) {
  const sessions = (await Promise.all(sources.map((s) => sessionsFrom(s).catch(() => [])))).flat();
  // The one thing this module remembers between polls, and it is pruned here
  // because only here is the whole live set in hand — a single source cannot
  // tell "gone" from "belongs to the other host".
  const live = new Set(sessions.map((s) => s.session_id));
  for (const id of workspaceMemory.keys()) if (!live.has(id)) workspaceMemory.delete(id);
  return sessions;
}

/**
 * Live sessions for one source: interactive, still running by that source's
 * own `isAlive`, and working in a folder some open VS Code window has in its
 * workspace.
 *
 * State comes from the registry's own `status` field rather than being
 * inferred from hooks — it distinguishes "waiting" and "requires_action"
 * (blocked on you) from plain "busy", which guessing from hook events can't.
 * Two narrow exceptions promote an "idle" session to "requires_action": a
 * last turn that ended right after an auto-mode permission denial
 * (`blockedOnDenial`), and one that ended on an unanswered `ExitPlanMode` or
 * `AskUserQuestion` call (`pendingTool`) — see `readTranscriptSignals`. The
 * registry can report either exact case as a plain completed turn, same as
 * any other idle session, so without this a session that just asked you to
 * approve a plan, answer a question, or grant a permission rule reads on the
 * deck as no different from one that's simply caught up.
 *
 * Two kinds of thing come back flagged `nested: true`, which index.mjs keeps
 * off the board's own slots: an SDK session (a separate process with its own
 * registry entry, told apart by `entrypoint`), and a running Agent-tool
 * subagent, which has no registry entry at all and is read off disk by
 * `readRunningSubagents`.
 */
async function sessionsFrom(source) {
  const [registry, locks, cmuxSurfaces] = await Promise.all([
    readJsonFiles(join(source.root, "sessions")),
    readJsonFiles(join(source.root, "ide"), [".lock"]),
    source.cmuxPath ? readCmuxSurfaces(source.cmuxPath) : Promise.resolve(new Map()),
  ]);

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
    // Nested = spawned by another session, and `entrypoint` is what says so.
    // A headless SDK run (a security review, a scripted agent) registers
    // itself as `kind: "interactive"` with the repo as its cwd, so `kind`
    // can't tell it from a session you opened — but its entrypoint is
    // "sdk-py"/"sdk-ts" where a session you started yourself is "cli".
    //
    // This used to be inferred from the cwd instead: anything below the
    // window's folder was called nested. That caught SDK helpers, and it also
    // caught every worktree — which is where most real work happens, so it
    // hid full agents behind a marker meant for background helpers. The
    // entrypoint says what the cwd only guessed at.
    //
    // Matching the sdk prefix rather than allowlisting "cli", so an entrypoint
    // we haven't seen yet gets a key rather than disappearing.
    const isNested = s.entrypoint?.startsWith("sdk") ?? false;
    if (!source.isAlive(s.pid)) continue;
    const ideMatch = matchFolder(s.cwd, folders);
    // cmux is a fallback, not a second vote: it only steps in for a session no
    // IDE window already covers, so a folder open in both keeps being focused
    // through VS Code/JetBrains exactly as before. cmux tells us the owning
    // surface *per session*, not per folder, so unlike an IDE lock this needs
    // no ancestor matching — a cmux session's own cwd is always the match.
    const cmuxSurface = !ideMatch ? cmuxSurfaces.get(s.sessionId) ?? null : null;
    const match = ideMatch ?? (cmuxSurface ? { folder: s.cwd } : null);
    if (!match) continue; // no live local window for this session
    matched.push({
      session_id: s.sessionId,
      cwd: s.cwd,
      folder: match.folder,
      // Claude's own pid, kept for terminal-focus.mjs: the VS Code terminal
      // running this session is the one whose shell is an ancestor of it.
      // Already read just above for the liveness check.
      pid: s.pid,
      ide: cmuxSurface ? "cmux" : ideByFolder.get(match.folder) ?? null,
      // Only set when `ide` is "cmux" — the surface `focusWindow` targets.
      cmuxSurface,
      nested: isNested,
      name: s.name ?? null,
      // Null, not "idle": an entry with no `status` field is a session that
      // doesn't report one, which `liveState` answers from the transcript
      // below. Only enrichment can tell the two apart, so the distinction has
      // to survive until then.
      state: s.status ?? null,
      ts: Math.floor((s.statusUpdatedAt ?? s.updatedAt ?? 0) / 1000),
      host: source.host,
      root: source.root,
      // Only a remote session carries its chain, and only because it cannot be
      // walked later: `requestFocus` runs inside a synchronous key handler, and
      // this host's pids mean something else entirely on the local machine. A
      // local session deliberately gets none — its table is read live at press
      // time, which is both correct and current.
      //
      // `undefined` rather than an empty array when the host gave no ppid
      // table: "no ancestry available" and "an ancestry with nothing in it" are
      // the same outcome for the reveal, but only the first reads as a fact
      // about the host rather than about the session.
      ...(source.ppids?.size ? { ancestors: ancestorChain(s.pid, source.ppids) } : {}),
    });
  }

  // An SDK session records no parent, but it has one: the Agent SDK spawns
  // `claude` as a subprocess, so whatever started it is in its pid ancestry.
  // Caught live on this machine — an `sdk-py` worker's chain read
  // `worker -> python3 -> the controller's own claude pid` — and without it
  // superpowers' SDD blinks: the controller runs an Agent-tool subagent for
  // the implementation (which does carry a parent) and an SDK session for the
  // review, so its key found the plan for one phase and lost it for the next.
  await attachSdkParents(matched, source);

  // Subagents have no registry entry of their own, so they're synthesised
  // here: nested, in their parent's folder, and busy — a running agent is by
  // definition working. They carry no aiTitle/context/progress (none of that
  // is written for them), so the transcript enrichment below is skipped and
  // the Agent call's own description is what the tile reads.
  //
  // `parent` is the session that spawned it, kept because `session_id` is
  // overwritten with the agent's own id just below. It's what lets index.mjs
  // put the marker on the key of the session actually running the agent: a
  // project with three sessions open in one folder would otherwise paint
  // whichever key happens to come first in the block, and an idle session
  // sitting green for a sibling's agent is a lie the deck can't be read past.
  // An SDK session has no such key to land on and carries no `parent`.
  const subagents = (
    await Promise.all(
      matched.map(async (s) =>
        (
          await readRunningSubagents(
            join(projectDirFor(s.cwd, source.root), s.session_id, "subagents"),
            source.tail,
            transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id }, source.root)
          )
        ).map((a) => ({
          ...s,
          session_id: a.id,
          // Where the agent is working, kept *beside* the parent's `cwd`
          // rather than replacing it: this session's transcript lives under
          // the parent's project slug (`subagentTranscriptPath`), so a cwd
          // pointing at the worktree would send every later reader to a
          // directory that doesn't hold it.
          agentCwd: a.cwd ?? null,
          parent: s.session_id,
          // What makes this an *Agent-tool* subagent, now that an SDK session
          // can carry a `parent` too: only these live at
          // `subagentTranscriptPath`, under their parent's project slug.
          subagent: true,
          nested: true,
          name: a.description,
          state: "busy",
          ts: a.ts,
        }))
      )
    )
  ).flat();

  // Both kinds of child, in one list: an Agent-tool subagent synthesised above
  // and an SDK session that has just been given its parent.
  const nestedAll = [...matched.filter((m) => m.nested), ...subagents];

  const enriched = await Promise.all(
    matched.map(async (s) => {
      const { blockedOnDenial, pendingTool, stopReason, compactRequestedAt, contextEstimate, ...signals } =
        await readTranscriptSignals(
          transcriptPathFor({ cwd: s.cwd, sessionId: s.session_id }, source.root),
          source.tail
        );
      // A manual /compact writes its command line the moment it starts, then
      // nothing until the finished boundary — so "newest user line is
      // /compact" IS the compaction, observed directly. Requiring busy is
      // what clears the spinner the instant a /compact is canceled (the
      // registry flips back to idle before any new transcript line lands),
      // and the age cap catches the stale-line leftovers busy can't.
      // Auto-triggered compactions write no start marker anywhere in the
      // transcript — an earlier silence heuristic tried inferring one and
      // false-fired on every turn that thought for 25s without a tool call —
      // so `marker` (compact-hook.mjs's PreCompact/PostCompact side channel)
      // is the only thing that can catch that case, on a machine that has it
      // installed; without it this falls back to manual-only, same as before.
      const marker = await readCompactMarker(s.session_id, source.root);
      const state = s.state ?? liveState(stopReason);
      const compacting = compactingNow({ state, compactRequestedAt, marker });
      return {
        ...s,
        ...signals,
        state: compacting
          ? "compacting"
          : state === "idle" && (blockedOnDenial || pendingTool)
            ? "requires_action"
            : state,
        // `source.host && null`: a remote session's cwd is a path on the other
        // machine, and only ~/.claude is fetched from it.
        // Two places a plan can be, in order. Claude Code's own tasks first,
        // then this session's cwd, then the cwd of a subagent it is *running*
        // — an SDD controller sits at the repo root and dispatches into the
        // worktree the plan lives in, and `findWorkspace` only ever walks up,
        // so its own cwd finds nothing while its agent stands inside the
        // workspace. Measured here: a controller nine tasks into a plan, key
        // blank the whole way.
        //
        // Only a subagent's, and only one it spawned itself (`parent`): eight
        // sessions were open at that repo root, and a plan found by scanning
        // the tree downward would have landed on all eight. This is the same
        // rule `nestedFor` follows for colour — a child may speak for its
        // parent, a sibling may not.
        progress: await readTaskProgress(
          s.session_id,
          source.root,
          source.host ? null : [s.cwd, ...agentCwds(s, nestedAll)]
        ),
        // The ctx file first — it knows the real window size. Without one (no
        // status line installed, here or on a remote host) the transcript's own
        // last usage carries the gauge, for the models whose window is known.
        context: (await readContext(s.session_id, source.root)) ?? contextEstimate,
      };
    })
  );

  return [...enriched, ...subagents];
}
