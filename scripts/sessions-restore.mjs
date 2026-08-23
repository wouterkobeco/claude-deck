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
import { basename, join } from "node:path";
import {
  BUNDLE_DIR_NAME,
  DIR_MODE,
  FILE_MODE,
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
console.log();
for (const p of plan) {
  const here = await exists(p.destCwd);
  console.log(`  ${here ? "·" : "!"} ${p.title ?? p.sourceId.slice(0, 8)}`);
  console.log(`      ${p.sourceCwd}`);
  console.log(`   -> ${p.destCwd}${here ? "" : "   (no such directory on this machine)"}`);
  console.log(`      ${p.sourceId.slice(0, 8)} -> ${p.newId.slice(0, 8)}${p.subagents ? `  +${p.subagents} subagents` : ""}`);
}
for (const s of skipped) console.log(`  ! skipped ${s.id?.slice(0, 8)} — ${s.why}`);

if (!write) {
  await rm(staging, { recursive: true, force: true });
  console.log(`\nNothing written. Add --write to restore, or --to=<source path>=<local path> to place a project elsewhere.`);
  process.exit(0);
}

let restored = 0;
for (const p of plan) {
  const destDir = join(CLAUDE_DIR, "projects", p.destSlug);
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
  const from = join(staging, "memory", proj.slug);
  if (!(await exists(from))) continue;
  const destFolder = folderMap[manifest.sessions.find((s) => s.cwd === proj.cwd)?.folder];
  const destCwd = destFolder ? remapCwd(proj.cwd, manifest.sessions.find((s) => s.cwd === proj.cwd).folder, destFolder) : null;
  if (!destCwd) continue;
  const to = join(CLAUDE_DIR, "projects", projectSlug(destCwd), "memory");
  await mkdir(to, { recursive: true });
  for (const f of await readdir(from)) {
    if (await exists(join(to, f))) {
      kept.push(f);
      continue;
    }
    await cp(join(from, f), join(to, f));
    notes++;
  }
}

await rm(staging, { recursive: true, force: true });

console.log(`\nRestored ${restored} session${restored === 1 ? "" : "s"}${notes ? `, ${notes} memory file${notes === 1 ? "" : "s"}` : ""}.`);
if (kept.length) console.log(`  kept this machine's own copy of: ${[...new Set(kept)].join(", ")}`);
console.log(`\nOpen each one with:`);
for (const p of plan) console.log(`  cd ${p.destCwd} && ${resumeCommand(p.newId)}`);
