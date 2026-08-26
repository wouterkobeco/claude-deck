// What the startup prompt decides a machine needs, the pure settings.json
// merge, and the installed hook script itself — the same split
// statusline-check.mjs drives, and for the same reason: the script around
// these is what touches the real ~/.claude.
// Run: node scripts/compact-hook-check.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOOK_COMMAND, HOOK_SCRIPT, decide, hasHook, withHooksInstalled } from "../src/compact-hook.mjs";

const eq = (a, b, msg) => assert.deepEqual(a, b, msg);

const ours = { matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] };
const someoneElses = { matcher: "", hooks: [{ type: "command", command: "~/.claude/something-else.sh" }] };

eq(hasHook(undefined), false, "no hooks at all");
eq(hasHook([someoneElses]), false, "somebody else's hook is not ours");
eq(hasHook([someoneElses, ours]), true, "ours alongside somebody else's");

// decide(): nothing to say once both hooks are wired and the script is
// current; anything else installs.
eq(decide({ script: HOOK_SCRIPT, hooks: { PreCompact: [ours], PostCompact: [ours] } }), "ok", "both hooks wired and script current is silent");
eq(decide({ script: null, hooks: {} }), "install", "nothing here at all");
eq(decide({ script: HOOK_SCRIPT, hooks: {} }), "install", "script written but settings.json never wired");
eq(decide({ script: HOOK_SCRIPT, hooks: { PreCompact: [ours] } }), "install", "PreCompact wired, PostCompact missing");
eq(decide({ script: "#!/bin/sh\necho old\n", hooks: { PreCompact: [ours], PostCompact: [ours] } }), "install", "hooks wired but the script itself is stale");

// withHooksInstalled: additive and idempotent — never a `manual` refusal here,
// because a hooks array is never one slot to conflict over the way statusLine
// is.
const fresh = withHooksInstalled({});
eq(hasHook(fresh.hooks.PreCompact), true, "PreCompact gets our entry from nothing");
eq(hasHook(fresh.hooks.PostCompact), true, "so does PostCompact");

const withOther = { other: "untouched", hooks: { PreCompact: [someoneElses] } };
const merged = withHooksInstalled(withOther);
eq(merged.hooks.PreCompact, [someoneElses, ours], "somebody else's PreCompact hook survives, ours is appended");
eq(merged.other, "untouched", "fields this doesn't know about are left alone");
eq(withHooksInstalled(merged).hooks.PreCompact, merged.hooks.PreCompact, "running it again adds nothing more");

// The script is shell: run it, rather than trusting a template literal is
// valid sh. PreCompact writes the marker, PostCompact clears it — for both
// trigger types, since Claude Code hands the same payload shape either way
// and only the matcher differs, which this hook doesn't use.
const execFileAsync = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "streamdeck-compact-hook-check-"));
const script = join(dir, "hook.sh");
await writeFile(script, HOOK_SCRIPT, { mode: 0o755 });
const sid = "0192abcd-0000-7000-8000-000000000000";
const markerPath = join(dir, ".claude/streamdeck-compact", `${sid}.json`);

const run = (event) =>
  execFileAsync("sh", ["-c", `echo '${JSON.stringify({ session_id: sid, hook_event_name: event, cwd: "/x" })}' | ${script}`], {
    env: { ...process.env, HOME: dir },
  });

await run("PreCompact");
const written = JSON.parse(await readFile(markerPath, "utf8"));
eq(typeof written.at, "number", "PreCompact writes a marker with a timestamp");

await run("PostCompact");
await assert.rejects(readFile(markerPath, "utf8"), "PostCompact clears the marker");

// A payload missing session_id (a hook payload shape this hasn't seen) is a
// no-op, not a crash — the grep/sed pipeline finds nothing and `[ -n "$sid" ]`
// bails before anything is written.
await execFileAsync("sh", ["-c", `echo '{"hook_event_name":"PreCompact"}' | ${script}`], { env: { ...process.env, HOME: dir } });

console.log("OK: compact-hook decision, settings merge, and the installed script itself");
