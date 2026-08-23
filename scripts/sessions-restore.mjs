// Restore sessions saved on another machine, with their full history.
//
// Run: npm run sessions:restore                    (list what is available)
//      npm run sessions:restore -- <bundle.tgz>    (show the plan)
//      npm run sessions:restore -- <bundle.tgz> --write
//
// Two steps on purpose. The default prints exactly what it would do and
// touches nothing: this is the one command in the project that writes *Claude
// Code's own* transcripts rather than the daemon's notes to itself, so seeing
// the plan before it lands is worth one extra word on the command line.
//
// Every session gets a **fresh id**. A bundle usually comes from a machine
// that still has the original, and two machines appending divergent histories
// under one id is a mess with no good ending. The ancestry is printed and
// recorded in the restored transcript's own `sessionId` chain-of-custody
// nowhere — which is the honest limit here: what you get is a copy that
// resumes, not the same session in two places.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile, chmod, cp, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { pushWholeFiles, remoteDirsExist } from "../src/remote-fs.mjs";
import { basename, join } from "node:path";
import {
  BUNDLE_DIR_NAME,
  DIR_MODE,
  FILE_MODE,
  memoryDirName,
  planRestore,
  projectSlug,
  remapCwd,
  resumeCommand,
  rewriteRecords,
} from "../src/session-transfer.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const BUNDLE_DIR = join(homedir(), BUNDLE_DIR_NAME);
const args = process.argv.slice(2);
const write = args.includes("--write");
const target = args.find((a) => !a.startsWith("-")) ?? null;
// Which machine the sessions land on. Default is this one; `--onto=<host>`
// sends them to a Remote-SSH host instead — which is the natural destination
// for sessions that came *off* that host, since their paths already match and
// nothing needs remapping at all.
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ontoArg = args.find((a) => a.startsWith("--onto="))?.slice(7) ?? null;
const onto = ontoArg && ontoArg !== "local" ? ontoArg : null;
if (onto && !HOST_RE.test(onto)) {
  console.error(`Not a hostname: ${onto}`);
  process.exit(1);
}
// Its own scratch root under /tmp, and short: this path anchors ssh's
// ControlPath socket, and os.tmpdir() on macOS is long enough to hit the
// ~104-byte sockaddr limit — a failure that presents as "host unreachable"
// with nothing pointing at the real cause. remote-fs.mjs records the same.
const sshRoot = `/tmp/streamdeck-restore-${process.pid}`;

// `--to <src>=<dest>` maps a project this machine keeps somewhere else.
const overrides = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--to="))
    .map((a) => a.slice(5).split("="))
    .filter(([a, b]) => a && b)
);

const run = (argv, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`))));
  });

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false
  );

if (!target) {
  const bundles = (await readdir(BUNDLE_DIR).catch(() => [])).filter((f) => f.endsWith(".tgz")).sort().reverse();
  if (bundles.length === 0) {
    console.log(`No bundles in ${BUNDLE_DIR}. Make one with:  npm run sessions:save`);
    process.exit(0);
  }
  console.log(`Bundles in ${BUNDLE_DIR}:`);
  for (const b of bundles) console.log(`  ${b}  (${((await stat(join(BUNDLE_DIR, b))).size / 1048576).toFixed(1)} MB)`);
  console.log(`\nInspect one with:  npm run sessions:restore -- ${bundles[0]}`);
  process.exit(0);
}

const archive = target.includes("/") ? target : join(BUNDLE_DIR, target);
if (!(await exists(archive))) {
  console.error(`No such bundle: ${archive}`);
  process.exit(1);
}

const staging = join(BUNDLE_DIR, `.restore-${basename(archive)}.staging`);
await mkdir(staging, { recursive: true, mode: DIR_MODE });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: DIR_MODE });
await run(["tar", "-xzf", archive, "-C", staging]);

const manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));

// Default mapping: keep each project's own path. That is right whenever both
// machines lay their checkouts out the same way, and `--to` is the answer when
// they don't — never a guess, since filing a session under a path this machine
// doesn't have puts it where `claude --resume` will not look.
const folderMap = {};
for (const s of manifest.sessions ?? []) folderMap[s.folder] = overrides[s.folder] ?? s.folder;

const { plan, skipped } = planRestore(manifest, folderMap);

console.log(`${basename(archive)} — saved ${manifest.savedAt} on ${manifest.host ?? "an unnamed machine"}`);
console.log(`restoring onto ${onto ?? "this machine"}`);
console.log();
// Asked once, of whichever machine is the destination. `null` back from a
// host means it could not be asked — unknown, which must not be drawn as
// "no such directory" beside every line.
let present = null;
if (onto) {
  await mkdir(sshRoot, { recursive: true, mode: 0o700 });
  present = await remoteDirsExist(onto, join(sshRoot, "cm-%h"), [...new Set(plan.map((p) => p.destCwd))]);
  if (present === null) console.log(`  (${onto} could not be reached, so nothing below is checked)`);
}
for (const p of plan) {
  const here = onto ? (present === null ? true : present.has(p.destCwd)) : await exists(p.destCwd);
  console.log(`  ${here ? "·" : "!"} ${p.title ?? p.sourceId.slice(0, 8)}${p.host ? `   (from ${p.host})` : ""}`);
  console.log(`      ${p.sourceCwd}`);
  console.log(`   -> ${p.destCwd}${here ? "" : `   (no such directory on ${onto ?? "this machine"})`}`);
  console.log(`      ${p.sourceId.slice(0, 8)} -> ${p.newId.slice(0, 8)}${p.subagents ? `  +${p.subagents} subagents` : ""}`);
}
for (const s of skipped) console.log(`  ! skipped ${s.id?.slice(0, 8)} — ${s.why}`);

if (!write) {
  await rm(staging, { recursive: true, force: true });
  await rm(sshRoot, { recursive: true, force: true });
  console.log(
    `\nNothing written. Add --write to restore, --onto=<host> to land them on another machine, or --to=<source path>=<local path> to place a project elsewhere.`
  );
  process.exit(0);
}

// Written into a tree shaped like `~/.claude` either way — which for a local
// restore simply *is* `~/.claude`, and for a remote one is a staging tree that
// gets pushed whole. One write path with two landings, rather than two write
// paths that would drift.
const landing = onto ? join(sshRoot, "payload") : CLAUDE_DIR;
if (onto) await mkdir(landing, { recursive: true, mode: 0o700 });

let restored = 0;
for (const p of plan) {
  const destDir = join(landing, "projects", p.destSlug);
  await mkdir(destDir, { recursive: true });

  const src = join(staging, "sessions", `${p.sourceId}.jsonl`);
  const lines = (await readFile(src, "utf8")).split("\n");
  // Prefix-based, so a worktree session's cwd keeps the suffix that makes it a
  // worktree rather than collapsing onto its project's own path.
  const cwdFor = (cwd) => remapCwd(cwd, p.sourceCwd, p.destCwd) ?? remapCwd(cwd, manifest.sessions.find((s) => s.id === p.sourceId)?.folder ?? p.sourceCwd, p.destCwd);
  await writeFile(join(destDir, `${p.newId}.jsonl`), rewriteRecords(lines, { newId: p.newId, cwdFor }).join("\n"), {
    mode: FILE_MODE,
  });

  // Subagents move under the *new* id: their directory is named for the parent
  // session, and their own records carry the parent's id in `sessionId`.
  const subs = join(staging, "sessions", p.sourceId, "subagents");
  if (await exists(subs)) {
    const destSubs = join(destDir, p.newId, "subagents");
    await mkdir(destSubs, { recursive: true });
    for (const f of await readdir(subs)) {
      if (f.endsWith(".jsonl")) {
        const l = (await readFile(join(subs, f), "utf8")).split("\n");
        await writeFile(join(destSubs, f), rewriteRecords(l, { newId: p.newId, cwdFor }).join("\n"), { mode: FILE_MODE });
      } else {
        await cp(join(subs, f), join(destSubs, f)); // .meta.json — no ids in it
      }
    }
  }
  restored++;
}

// Project memory, and never over the top of memory this machine already has:
// a note written here is this machine's own, and a restore is not a reason to
// lose it. Only files that don't exist yet are written, and the rest is said
// out loud rather than silently skipped.
let notes = 0;
const kept = [];
for (const proj of manifest.projects ?? []) {
  const from = join(staging, "memory", memoryDirName(proj));
  if (!(await exists(from))) continue;
  const destFolder = folderMap[manifest.sessions.find((s) => s.cwd === proj.cwd)?.folder];
  const destCwd = destFolder ? remapCwd(proj.cwd, manifest.sessions.find((s) => s.cwd === proj.cwd).folder, destFolder) : null;
  if (!destCwd) continue;
  const to = join(landing, "projects", projectSlug(destCwd), "memory");
  await mkdir(to, { recursive: true });
  for (const f of await readdir(from)) {
    // Never over the top of memory that is already there. For a local restore
    // that is a real check; for a remote one this staging tree is empty, so
    // the guard has to happen on the far side — which `tar -x` does not do.
    // Said out loud below rather than pretended about.
    if (!onto && (await exists(join(to, f)))) {
      kept.push(f);
      continue;
    }
    await cp(join(from, f), join(to, f));
    notes++;
  }
}

// The landing, for a remote destination: one tar over the connection the
// plan's probe already opened.
if (onto) {
  process.stdout.write(`  sending to ${onto}… `);
  const ok = await pushWholeFiles(onto, join(sshRoot, "cm-%h"), landing);
  console.log(ok ? "ok" : "failed");
  if (!ok) {
    await rm(staging, { recursive: true, force: true });
    await rm(sshRoot, { recursive: true, force: true });
    console.error(`Nothing landed on ${onto}. Its ~/.claude is untouched.`);
    process.exit(1);
  }
}

await rm(staging, { recursive: true, force: true });
await rm(sshRoot, { recursive: true, force: true });

console.log(
  `\nRestored ${restored} session${restored === 1 ? "" : "s"}${notes ? `, ${notes} memory file${notes === 1 ? "" : "s"}` : ""} onto ${onto ?? "this machine"}.`
);
if (kept.length) console.log(`  kept this machine's own copy of: ${[...new Set(kept)].join(", ")}`);
// A remote landing is a `tar -x`, which overwrites rather than merging — so
// the memory guard that protects a local restore cannot run there, and saying
// so beats implying a safety that isn't present.
if (onto && notes) console.log(`  note: ${onto}'s own memory files with these names were overwritten`);
console.log(`\nOpen each one with${onto ? ` (on ${onto})` : ""}:`);
for (const p of plan) console.log(`  cd ${p.destCwd} && ${resumeCommand(p.newId)}`);
