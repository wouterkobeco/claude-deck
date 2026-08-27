// Installs the status line and the compaction hooks a remote host needs.
// Manual and explicit: `npm run remote:install -- <host>`. The same probe and
// write functions are also called, host by host, from `remote-prestart.mjs`
// at `npm start` — one copy of "what does this host need and how do we give
// it that" rather than two drifting apart.
//
// This is the one place in the project that writes to a machine other than
// this one. It is never wired into `postinstall` — `npm install` reaching
// across ssh to edit another machine's config is not a trade this project
// makes — and the status line half refuses rather than overwrites wherever
// something is already there: it is read on every turn, and replacing one to
// add a gauge to a Stream Deck key is not a fair trade. The compaction-hooks
// half never needs to refuse anything — see compact-hook.mjs for why a hooks
// array has nothing to conflict over.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validHost } from "../src/window-state.mjs";
import { sshArgs } from "../src/remote-fs.mjs";
// The block and the whole minimal script live in src/statusline.mjs, shared
// with the local installer: two copies of a shell block is two things to keep
// in step, and only one of them would ever be the one you tested.
import { MINIMAL, SCRIPT_NAME } from "../src/statusline.mjs";
// Same reuse for the compaction-detection hooks: `decide`/`withHooksInstalled`
// are the one copy of that rule, shared with compact-hook-prestart.mjs.
import { HOOK_SCRIPT, SCRIPT_NAME as COMPACT_SCRIPT_NAME, decide as decideCompactHook, withHooksInstalled } from "../src/compact-hook.mjs";

// The default for a command someone is running once and will wait on. A
// per-host probe from `npm start` passes its own, much shorter timeout — see
// remote-prestart.mjs — because that one runs on every launch and must not
// learn to wait on a host that's asleep.
const TIMEOUT_MS = 30_000;
const LOCAL_STATUSLINE = join(homedir(), ".claude", SCRIPT_NAME);

/**
 * Everything this needs to know about a host's status line, in one round
 * trip, before anything is written.
 *
 * Takes its directory from `$CLAUDE_DIR` so the check can point it at a fixture
 * and run it under a real shell. What this makes is a *shell* decision, and a
 * check that asserted the string instead would have passed just as happily
 * while the semantics were wrong.
 *
 * **`-s`, not `-e`.** A zero-byte `statusline-command.sh` is not a status line
 * anyone wrote — it is a placeholder, a truncated write, or a `touch` — and
 * refusing to install over it protects nothing while blocking the one command
 * that would fix it. Seen for real: an empty executable appeared on a host that
 * had none, with no `statusLine` key even referencing it, and the install
 * refused itself out of a file with nothing in it.
 */
export const STATE_PROBE =
  ': "${CLAUDE_DIR:=$HOME/.claude}"; ' +
  'printf "jq=%s\\n" "$(command -v jq || echo NONE)"; ' +
  'printf "script=%s\\n" "$([ -s "$CLAUDE_DIR/statusline-command.sh" ] && echo YES || echo NO)"; ' +
  'printf "key=%s\\n" "$(jq -r \'if has("statusLine") then "YES" else "NO" end\' "$CLAUDE_DIR/settings.json" 2>/dev/null || echo UNKNOWN)"';

// Split on the first `=` only: a value can contain one (jq's path, say).
export function parseState(stdout) {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const at = l.indexOf("=");
        return [l.slice(0, at), l.slice(at + 1)];
      })
  );
}

// Only when run as a command, never on import — the check (and
// remote-prestart.mjs) import STATE_PROBE/COMPACT_HOOK_PROBE and the
// probe/apply functions below, and a module that exits on import cannot be
// checked or reused. Same guard `index.mjs` uses to stop an import starting a
// daemon.
const isCommand = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

const cliHost = isCommand ? validHost(process.argv[2]) : null;
if (isCommand && !cliHost) {
  console.error("usage: npm run remote:install -- <host>");
  console.error("       <host> is an ssh target, the same one the deck shows for that window.");
  if (process.argv[2]) console.error(`\nrefused ${JSON.stringify(process.argv[2])}: not a plain hostname.`);
  process.exit(1);
}

/**
 * Run one command on `host`, optionally feeding it stdin.
 *
 * `spawn` and an explicit `stdin.end()`, **not** `execFile` with `{ input }`.
 * That option exists only on the *Sync* variants — `execFileSync`,
 * `spawnSync` — and async `execFile` ignores it silently, leaving the child's
 * stdin pipe open forever. The remote's `cat > …` then waits for an EOF that
 * never comes and the whole command hangs, which is exactly what it did.
 *
 * The timeout is the second half of that lesson: a command that reads stdin has
 * no natural end if the writer never finishes, so this cannot be left to good
 * behaviour. `host` is folded into the control path (rather than ssh's own
 * `%h`, which only helps when one fixed argv is reused across hosts) because
 * this now runs several hosts from one process at once — a shared path would
 * point two different hosts' control masters at the same socket.
 */
function ssh(host, command, input, timeoutMs = TIMEOUT_MS) {
  const controlPath = join("/tmp", `streamdeck-install-${process.pid}-${host}`);
  const args = [...sshArgs(host, controlPath), command];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(kill);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      const stderr = Buffer.concat(err).toString();
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString(), stderr });
      else reject(Object.assign(new Error(`ssh exited ${code}`), { stderr }));
    });
    // EPIPE if the far end closed early — the close handler above reports the
    // real reason, and an unhandled error event here would mask it.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

// Separator between the two blobs fetched in one round trip below. NUL is
// safe: a shell script and a JSON file are both text, and neither can
// contain a NUL byte the way a live transcript can't (same reasoning
// remote-fs.mjs's TAILS_CMD makes for its own NUL framing).
//
// The command sent to `ssh` has to spell it `\0` for the *remote* `printf` to
// turn into a byte — `spawn` refuses any local argv string that already
// contains a literal NUL, which is what interpolating this constant into the
// command itself did the first time. `NUL` here is only ever compared against
// bytes `ssh` already returned, never embedded back into another command.
const NUL = "\0";

// The probe for probeCompactHook, named and exported for the same reason
// STATE_PROBE is: a check can assert its shape without running anything.
// **Must spell the separator `\0` (backslash, zero) as literal text, never
// interpolate an actual NUL character in** — `spawn` refuses any local argv
// string that already contains one, which is exactly the shape of bug this
// was shipped with once: interpolating the constant into this same template
// crashed every call with "must be a string without null bytes" before it
// ever reached ssh.
export const COMPACT_HOOK_PROBE = `cat ~/.claude/${COMPACT_SCRIPT_NAME} 2>/dev/null; printf '\\0'; cat ~/.claude/settings.json 2>/dev/null`;

/**
 * What `host` needs for the PreCompact/PostCompact hooks, without writing
 * anything — `remote-prestart.mjs` runs this for several hosts at once, so it
 * has to stay silent and side-effect-free to be worth parallelising.
 *
 * Fetches the remote script and settings.json as plain text and runs them
 * through the exact same pure `decide` the local prestart uses, rather than
 * reaching for jq on the remote — one copy of the decision, and the round
 * trip is already needed either way.
 *
 * `action` is `"ok"` (nothing to do), `"install"` (write both files — call
 * `applyCompactHook` with the `settings` this also returns), or
 * `"unparseable"` (settings.json isn't valid JSON, so there is nothing safe
 * to merge into).
 */
export async function probeCompactHook(host, { timeoutMs } = {}) {
  const { stdout } = await ssh(host, COMPACT_HOOK_PROBE, undefined, timeoutMs);
  const at = stdout.indexOf(NUL);
  const script = stdout.slice(0, at) || null;
  let settings;
  try {
    settings = JSON.parse(stdout.slice(at + 1) || "{}");
  } catch {
    return { action: "unparseable" };
  }
  return { action: decideCompactHook({ script, hooks: settings.hooks }), settings };
}

/** Writes what `probeCompactHook` found missing. Never refuses — see the module doc for why a hooks array has nothing to conflict over. */
export async function applyCompactHook(host, settings, { timeoutMs } = {}) {
  await ssh(
    host,
    `mkdir -p ~/.claude && cat > ~/.claude/${COMPACT_SCRIPT_NAME}.tmp && ` +
      `if [ -s ~/.claude/${COMPACT_SCRIPT_NAME}.tmp ]; then ` +
      `chmod +x ~/.claude/${COMPACT_SCRIPT_NAME}.tmp && mv ~/.claude/${COMPACT_SCRIPT_NAME}.tmp ~/.claude/${COMPACT_SCRIPT_NAME}; ` +
      `else rm -f ~/.claude/${COMPACT_SCRIPT_NAME}.tmp; exit 1; fi`,
    HOOK_SCRIPT,
    timeoutMs
  );
  await ssh(
    host,
    "mkdir -p ~/.claude && cat > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json",
    `${JSON.stringify(withHooksInstalled(settings), null, 2)}\n`,
    timeoutMs
  );
}

/**
 * What `host` needs for its status line, without writing anything.
 *
 * `action` is `"install"` (nothing there — write one), `"nojq"` (the block
 * needs it and there is none), `"has-script"`/`"has-key"` (something is
 * already there — the CLI refuses over these; `remote-prestart.mjs` treats
 * them the same as `"ok"`, since a customised status line isn't something to
 * keep mentioning on every launch), or `"ok"`.
 */
export async function probeStatusLine(host, { timeoutMs } = {}) {
  const { stdout } = await ssh(host, STATE_PROBE, undefined, timeoutMs);
  const state = parseState(stdout);
  if (state.jq === "NONE") return { action: "nojq", state };
  if (state.script === "YES") return { action: "has-script", state };
  if (state.key === "YES") return { action: "has-key", state };
  return { action: "install", state };
}

/**
 * Writes a status line to `host` — this machine's own if it has the ctx
 * block, `MINIMAL` otherwise. Never call this without checking
 * `probeStatusLine` first: unlike the compaction hooks, this assumes the
 * refusal cases have already been handled by the caller.
 *
 * Resolves `{ ok: false, reason }` for the one case that isn't an ssh
 * failure — this machine's own status line exists but has no ctx block, so
 * copying it would ship a gauge that can't work on the remote either.
 * Everything else that goes wrong rejects, the same as every other call here.
 */
export async function applyStatusLine(host, { timeoutMs } = {}) {
  let body = MINIMAL;
  let source = "the minimal block (no local status line to copy)";
  try {
    body = await readFile(LOCAL_STATUSLINE, "utf8");
    source = LOCAL_STATUSLINE;
    if (!body.includes("ctx_dir")) return { ok: false, reason: "no-local-ctx-block" };
  } catch {
    // no local status line — MINIMAL it is
  }

  // Written via a temp file and moved into place, the same way the block itself
  // writes ctx files: a status line read while half-written would break every
  // turn on that host until the next write.
  // `[ -s ]` on the temp file before the `mv`, and remove it otherwise. An
  // interrupted `cat` exits *0* with nothing written, so without this check the
  // chain cheerfully chmods and moves an empty file into place — which is how a
  // zero-byte status line appeared on a real host, twice, and then blocked the
  // install that would have fixed it. Never leave the tmp behind either: it is
  // the thing the next run would trip over.
  await ssh(
    host,
    "mkdir -p ~/.claude && cat > ~/.claude/statusline-command.sh.tmp && " +
      "if [ -s ~/.claude/statusline-command.sh.tmp ]; then " +
      "chmod +x ~/.claude/statusline-command.sh.tmp && " +
      "mv ~/.claude/statusline-command.sh.tmp ~/.claude/statusline-command.sh; " +
      "else rm -f ~/.claude/statusline-command.sh.tmp; exit 1; fi",
    body,
    timeoutMs
  );

  // jq rather than a rewrite, so everything else in settings.json survives
  // untouched — that file holds plugins, theme, and whatever else that host
  // has, none of which is ours to reformat.
  await ssh(
    host,
    'cd ~/.claude && { [ -e settings.json ] || echo "{}" > settings.json; } && ' +
      'jq \'.statusLine = {"type": "command", "command": "~/.claude/statusline-command.sh"}\' settings.json > settings.json.tmp && ' +
      "mv settings.json.tmp settings.json",
    undefined,
    timeoutMs
  );

  return { ok: true, source };
}

async function main() {
  // Independent of the status line below: a hooks array is additive, so
  // unlike the status line there is nothing here to refuse over and nothing
  // it can break by running regardless of what the status line decides.
  const ch = await probeCompactHook(cliHost);
  if (ch.action === "unparseable") {
    console.error(`${cliHost}: settings.json isn't valid JSON — skipping the PreCompact/PostCompact hooks (auto-compaction won't show for sessions there). Add them from README.md by hand once it's fixed.`);
  } else if (ch.action === "install") {
    await applyCompactHook(cliHost, ch.settings);
    console.log(`${cliHost}: PreCompact/PostCompact hooks installed — auto-triggered compactions will show there too.`);
  }

  const sl = await probeStatusLine(cliHost);
  if (sl.action === "nojq") {
    console.error(`${cliHost}: no jq. The status line block parses Claude Code's JSON with it; install jq and re-run.`);
    process.exit(1);
  }
  if (sl.action === "has-script") {
    console.error(`${cliHost}: ~/.claude/statusline-command.sh already has content — not overwriting it.`);
    console.error("Add the block from README.md's context-gauge section to it by hand instead.");
    process.exit(1);
  }
  if (sl.action === "has-key") {
    console.error(`${cliHost}: settings.json already sets statusLine — not replacing it.`);
    console.error("Add the block from README.md's context-gauge section to whatever it points at.");
    process.exit(1);
  }

  const result = await applyStatusLine(cliHost);
  if (!result.ok) {
    console.error(`${LOCAL_STATUSLINE} has no ctx block — the gauge would not work on the remote either.`);
    console.error("Add the block from README.md's context-gauge section locally first, then re-run.");
    process.exit(1);
  }
  console.log(`${cliHost}: status line installed from ${result.source}`);
  console.log("Its context gauge appears once that host writes its first ctx file — a session there has to take a turn.");
}

if (isCommand) {
  main().catch((err) => {
    console.error(`${cliHost}: install failed:`, err.stderr?.trim() || err.message);
    process.exit(1);
  });
}
