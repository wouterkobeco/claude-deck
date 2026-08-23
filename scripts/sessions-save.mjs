// Save this machine's live sessions — full history — into one archive you can
// carry to another machine.
//
// Run: npm run sessions:save            (every live session)
//      npm run sessions:save -- kob     (only projects whose folder matches)
//
// A command you run, never anything automatic: it writes megabytes and it
// writes a verbatim copy of every conversation, which is not a thing to do on
// a timer behind someone's back. The reading and tarring live here; every
// decision they make is in src/session-transfer.mjs, where a check can drive
// it without touching the real ~/.claude.
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile, chmod, cp, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { getLiveSessions } from "../src/sessions.mjs";
import { BUNDLE_DIR_NAME, DIR_MODE, FILE_MODE, buildManifest, bundleName, projectSlug } from "../src/session-transfer.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const BUNDLE_DIR = join(homedir(), BUNDLE_DIR_NAME);
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"))[0] ?? null;

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

const sessions = (await getLiveSessions()).filter(
  // Nested sessions have no session of their own to resume — an Agent-tool
  // subagent runs inside its parent and an SDK one was started by a script —
  // so restoring either would open something nobody opened. They still travel,
  // as their parent's `subagents/` directory.
  (s) => !s.nested && !s.host && (!filter || s.folder.includes(filter) || s.cwd.includes(filter))
);

if (sessions.length === 0) {
  console.log(filter ? `No local sessions matching "${filter}".` : "No local sessions to save.");
  process.exit(0);
}

const now = Date.now();
const name = bundleName(now);
const staging = join(BUNDLE_DIR, `.${name}.staging`);
await mkdir(BUNDLE_DIR, { recursive: true, mode: DIR_MODE });
await chmod(BUNDLE_DIR, DIR_MODE).catch(() => {});
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "sessions"), { recursive: true, mode: DIR_MODE });

let copied = 0;
let bytes = 0;
let agents = 0;
const saved = [];

for (const s of sessions) {
  const slug = projectSlug(s.cwd);
  const transcript = join(CLAUDE_DIR, "projects", slug, `${s.session_id}.jsonl`);
  if (!(await exists(transcript))) {
    console.error(`  skipped ${s.session_id.slice(0, 8)} — no transcript on disk`);
    continue;
  }
  await cp(transcript, join(staging, "sessions", `${s.session_id}.jsonl`));
  bytes += (await stat(transcript)).size;
  copied++;

  // The subagent transcripts this session spawned, with their .meta.json
  // sidecars — the sidecar is what carries the Agent call's own description,
  // so without it a restored subagent has no name.
  const subs = join(CLAUDE_DIR, "projects", slug, s.session_id, "subagents");
  let subCount = 0;
  if (await exists(subs)) {
    await cp(subs, join(staging, "sessions", s.session_id, "subagents"), { recursive: true });
    subCount = (await readdir(subs)).filter((f) => f.endsWith(".jsonl")).length;
    agents += subCount;
  }
  saved.push({ ...s, subagents: subCount });
}

if (copied === 0) {
  await rm(staging, { recursive: true, force: true });
  console.error("Nothing saved: none of those sessions has a transcript on disk.");
  process.exit(1);
}

// Per-project memory, once per distinct cwd rather than once per session.
let memories = 0;
for (const { cwd, slug } of buildManifest(saved, now, null).projects) {
  const dir = join(CLAUDE_DIR, "projects", slug, "memory");
  if (!(await exists(dir))) continue;
  await cp(dir, join(staging, "memory", slug), { recursive: true });
  memories++;
}

const manifest = buildManifest(saved, now, hostname());
await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: FILE_MODE });

// manifest.json first, so a restore can read what is in a bundle without
// pulling megabytes of transcript through the decompressor.
const archive = join(BUNDLE_DIR, `${name}.tgz`);
await run(["tar", "-czf", archive, "manifest.json", "sessions", ...(memories ? ["memory"] : [])], staging);
await chmod(archive, FILE_MODE).catch(() => {});
await rm(staging, { recursive: true, force: true });

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`Saved ${copied} session${copied === 1 ? "" : "s"} (${mb(bytes)} MB of history${
  agents ? `, ${agents} subagent transcript${agents === 1 ? "" : "s"}` : ""
}${memories ? `, ${memories} project memor${memories === 1 ? "y" : "ies"}` : ""})`);
console.log(`  ${archive}  (${mb((await stat(archive)).size)} MB)`);
for (const s of saved) console.log(`  · ${s.folder.split("/").filter(Boolean).pop()} — ${s.title ?? s.session_id.slice(0, 8)}`);
console.log(`\nCopy it to the other machine and run:  npm run sessions:restore -- ${name}.tgz`);
