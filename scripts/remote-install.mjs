// Installs the status line a remote host needs before its sessions can show a
// context gauge. Manual and explicit: `npm run remote:install -- <host>`.
//
// This is the one thing in the project that writes to a machine other than this
// one, which is why it is a command you run rather than anything the daemon
// does. It is never wired into `postinstall` — `npm install` reaching across
// ssh to edit another machine's config is not a trade this project makes.
//
// Why it is needed at all: Claude Code hands a session's context percentage to
// the status line and nowhere else. `~/.claude/ctx/<id>.json` is a side channel
// the status line writes for the daemon to read, and a host without one simply
// has no context to report — the gauge stays off, which is exactly what happens
// on a local machine without a status line.
//
// Refuses rather than overwrites, in every case where something is already
// there. A status line is a thing the user sees on every turn, and silently
// replacing one to add a gauge to a Stream Deck key is not a fair trade.
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

// Nothing here should take anywhere near this long — the probe is one round
// trip and the writes are a few hundred bytes. It exists so a command that
// reads stdin can never wait forever, which is precisely how this failed once.
const TIMEOUT_MS = 30_000;
const LOCAL_STATUSLINE = join(homedir(), ".claude", SCRIPT_NAME);

/**
 * Everything this needs to know about a host, in one round trip, before
 * anything is written.
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

// Only when run as a command, never on import — the check imports STATE_PROBE
// and parseState, and a module that exits on import cannot be checked. Same
// guard `index.mjs` uses to stop an import starting a daemon.
const isCommand = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

const host = isCommand ? validHost(process.argv[2]) : null;
if (isCommand && !host) {
  console.error("usage: npm run remote:install -- <host>");
  console.error("       <host> is an ssh target, the same one the deck shows for that window.");
  if (process.argv[2]) console.error(`\nrefused ${JSON.stringify(process.argv[2])}: not a plain hostname.`);
  process.exit(1);
}

/**
 * Run one command on the host, optionally feeding it stdin.
 *
 * `spawn` and an explicit `stdin.end()`, **not** `execFile` with `{ input }`.
 * That option exists only on the *Sync* variants — `execFileSync`,
 * `spawnSync` — and async `execFile` ignores it silently, leaving the child's
 * stdin pipe open forever. The remote's `cat > …` then waits for an EOF that
 * never comes and the whole command hangs, which is exactly what it did.
 *
 * The timeout is the second half of that lesson: a command that reads stdin has
 * no natural end if the writer never finishes, so this cannot be left to good
 * behaviour.
 */
function ssh(command, input) {
  const args = [...sshArgs(host, join("/tmp", `streamdeck-install-${process.pid}`)), command];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
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

// The probe for installCompactHook, named and exported for the same reason
// STATE_PROBE is: a check can assert its shape without running `main()`.
// **Must spell the separator `\0` (backslash, zero) as literal text, never
// interpolate an actual NUL character in** — `spawn` refuses any local argv
// string that already contains one, which is exactly the shape of bug this
// was shipped with once: `${NUL}` in this same template crashed every call
// with "must be a string without null bytes" before it ever reached ssh.
export const COMPACT_HOOK_PROBE = `cat ~/.claude/${COMPACT_SCRIPT_NAME} 2>/dev/null; printf '\\0'; cat ~/.claude/settings.json 2>/dev/null`;

/**
 * Install compact-hook.mjs's PreCompact/PostCompact hooks on `host`, entirely
 * independent of the status line below: a hooks array is additive, so unlike
 * the status line there is nothing to refuse over and nothing this can break
 * by running regardless of what the status line install decides.
 *
 * Fetches the remote script and settings.json as plain text and runs them
 * through the exact same pure `decide`/`withHooksInstalled` the local
 * prestart uses, rather than reaching for jq on the remote — one copy of the
 * merge logic, and the write-back is what already needs an ssh round trip
 * either way.
 */
async function installCompactHook() {
  const { stdout } = await ssh(COMPACT_HOOK_PROBE);
  const at = stdout.indexOf(NUL);
  const script = stdout.slice(0, at) || null;
  const settingsRaw = stdout.slice(at + 1);

  let settings;
  try {
    settings = JSON.parse(settingsRaw || "{}");
  } catch {
    console.error(`${host}: settings.json isn't valid JSON — skipping the PreCompact/PostCompact hooks (auto-compaction won't show for sessions there). Add them from README.md by hand once it's fixed.`);
    return;
  }

  if (decideCompactHook({ script, hooks: settings.hooks }) === "ok") return;

  await ssh(
    `mkdir -p ~/.claude && cat > ~/.claude/${COMPACT_SCRIPT_NAME}.tmp && ` +
      `if [ -s ~/.claude/${COMPACT_SCRIPT_NAME}.tmp ]; then ` +
      `chmod +x ~/.claude/${COMPACT_SCRIPT_NAME}.tmp && mv ~/.claude/${COMPACT_SCRIPT_NAME}.tmp ~/.claude/${COMPACT_SCRIPT_NAME}; ` +
      `else rm -f ~/.claude/${COMPACT_SCRIPT_NAME}.tmp; exit 1; fi`,
    HOOK_SCRIPT
  );
  await ssh(
    "mkdir -p ~/.claude && cat > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json",
    `${JSON.stringify(withHooksInstalled(settings), null, 2)}\n`
  );
  console.log(`${host}: PreCompact/PostCompact hooks installed — auto-triggered compactions will show there too.`);
}

async function main() {
  // Independent of everything below: see installCompactHook's own doc for why
  // it can never conflict with the status line install that follows.
  await installCompactHook();

  // Everything this needs to know about the host, in one round trip, before
  // anything is written.
  const { stdout } = await ssh(STATE_PROBE);
  const state = parseState(stdout);

  if (state.jq === "NONE") {
    console.error(`${host}: no jq. The status line block parses Claude Code's JSON with it; install jq and re-run.`);
    process.exit(1);
  }
  if (state.script === "YES") {
    console.error(`${host}: ~/.claude/statusline-command.sh already has content — not overwriting it.`);
    console.error("Add the block from README.md's context-gauge section to it by hand instead.");
    process.exit(1);
  }
  if (state.key === "YES") {
    console.error(`${host}: settings.json already sets statusLine — not replacing it.`);
    console.error("Add the block from README.md's context-gauge section to whatever it points at.");
    process.exit(1);
  }

  // Prefer this machine's own status line, so the remote's looks like the one
  // you already read every day rather than something this script invented. It
  // is plain bash + jq + git, which is why copying it is safe.
  let body = MINIMAL;
  let source = "the minimal block (no local status line to copy)";
  try {
    body = await readFile(LOCAL_STATUSLINE, "utf8");
    source = LOCAL_STATUSLINE;
    if (!body.includes("ctx_dir")) {
      console.error(`${LOCAL_STATUSLINE} has no ctx block — the gauge would not work on the remote either.`);
      console.error("Add the block from README.md's context-gauge section locally first, then re-run.");
      process.exit(1);
    }
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
    "mkdir -p ~/.claude && cat > ~/.claude/statusline-command.sh.tmp && " +
      "if [ -s ~/.claude/statusline-command.sh.tmp ]; then " +
      "chmod +x ~/.claude/statusline-command.sh.tmp && " +
      "mv ~/.claude/statusline-command.sh.tmp ~/.claude/statusline-command.sh; " +
      "else rm -f ~/.claude/statusline-command.sh.tmp; exit 1; fi",
    body
  );

  // jq rather than a rewrite, so everything else in settings.json survives
  // untouched — that file holds plugins, theme, and whatever else that host
  // has, none of which is ours to reformat.
  await ssh(
    'cd ~/.claude && { [ -e settings.json ] || echo "{}" > settings.json; } && ' +
      'jq \'.statusLine = {"type": "command", "command": "~/.claude/statusline-command.sh"}\' settings.json > settings.json.tmp && ' +
      "mv settings.json.tmp settings.json"
  );

  console.log(`${host}: status line installed from ${source}`);
  console.log("Its context gauge appears once that host writes its first ctx file — a session there has to take a turn.");
}

if (isCommand) {
  main().catch((err) => {
    console.error(`${host}: install failed:`, err.stderr?.trim() || err.message);
    process.exit(1);
  });
}
