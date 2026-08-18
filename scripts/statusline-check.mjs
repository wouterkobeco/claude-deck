// What the startup prompt decides a machine needs, and where the block lands
// when it edits an existing status line.
//
// Both are pure and in src/statusline.mjs precisely so this can run them: the
// script around them writes to the real ~/.claude, so a check that drove *that*
// would edit whatever status line this machine happens to have.
// Run: node scripts/statusline-check.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CTX_BLOCK, MINIMAL, decide, insertBlock } from "../src/statusline.mjs";

const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const withCtx = `#!/usr/bin/env bash\ninput=$(cat)\n${CTX_BLOCK}\n`;
const plain = `#!/usr/bin/env bash\ninput=$(cat)\nprintf 'hi'\n`;

// Nothing to say when the block is there: a prestart that speaks on every start
// is one people learn to scroll past, and this one has to still be readable the
// day it says something.
eq(decide({ jq: true, script: withCtx, statusLine: "~/.claude/statusline-command.sh" }), "ok", "an installed block is silent");
eq(decide({ jq: false, script: withCtx, statusLine: null }), "ok", "and stays silent without jq — that status line is the user's problem, not a fresh proposal");

// jq is checked before anything is proposed, not after: the block parses
// Claude Code's JSON with it, so writing one on a machine without it installs
// something that cannot work.
eq(decide({ jq: false, script: null, statusLine: null }), "nojq", "no jq, nothing proposed");

// A machine with nothing: the only case that writes settings.json.
eq(decide({ jq: true, script: null, statusLine: null }), "install", "no status line at all installs one");
eq(decide({ jq: true, script: "", statusLine: null }), "install", "and an empty file counts as none, same -s lesson as remote:install");

// A status line of the user's own, with the line the block needs.
eq(decide({ jq: true, script: plain, statusLine: null }), "append", "an existing status line gets the block added");
eq(decide({ jq: true, script: plain, statusLine: "~/.claude/statusline-command.sh" }), "append", "even when settings.json already points at it");

// Everything this can't reason about is described rather than edited.
eq(
  decide({ jq: true, script: plain, statusLine: "bun ~/.claude/ccstatusline.ts" }),
  "manual",
  "settings.json pointing elsewhere means editing this file would change nothing"
);
eq(
  decide({ jq: true, script: "#!/bin/sh\nread -r line\necho hi\n", statusLine: null }),
  "manual",
  "a status line that reads stdin some other way is left alone"
);
eq(decide({ jq: true, script: null, statusLine: "bun ~/foo.ts" }), "manual", "and so is a machine whose status line is not a shell script here");

// Where the block lands. After `input=$(cat)`, never appended: the block reads
// $input, and a script ending in an exit would swallow it silently.
const edited = insertBlock(plain);
const lines = edited.split("\n");
eq(lines[1], "input=$(cat)", "the anchor line survives");
eq(lines[2], "", "a blank line separates the block");
eq(lines[3], CTX_BLOCK.split("\n")[0], "and the block starts right after it");
eq(edited.includes("printf 'hi'"), true, "the rest of the status line is untouched");
eq(insertBlock("#!/bin/sh\necho hi\n"), null, "no anchor, no guess");

// The two shell strings are shell: run them, rather than trusting that a
// heredoc-shaped template literal is valid bash. MINIMAL is what a fresh
// machine gets, and a syntax error in it breaks every turn on that machine.
const execFileAsync = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "streamdeck-statusline-check-"));
const script = join(dir, "statusline.sh");
await writeFile(script, MINIMAL, { mode: 0o755 });
const payload = JSON.stringify({
  session_id: "0192abcd-0000-7000-8000-000000000000",
  context_window: { used_percentage: 42 },
  workspace: { current_dir: "/projects/x" },
});
const { stdout } = await execFileAsync("bash", ["-c", `echo '${payload}' | ${script}`], { env: { ...process.env, HOME: dir } });
eq(stdout, "/projects/x", "MINIMAL prints the status line it promises");
const written = await execFileAsync("cat", [join(dir, ".claude/ctx/0192abcd-0000-7000-8000-000000000000.json")]);
eq(written.stdout.trim(), '{"context":42}', "and writes the ctx file the gauge reads");

console.log("OK: statusline decision, block placement, and the installed script itself");
