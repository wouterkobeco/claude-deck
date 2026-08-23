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
import { mkdir, readdir, readFile, rm, writeFile, chmod, cp, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { getLiveSessions } from "../src/sessions.mjs";
import { fetchWholeFiles } from "../src/remote-fs.mjs";
import { BUNDLE_DIR_NAME, DIR_MODE, FILE_MODE, buildManifest, bundleName, memoryDirName, projectSlug } from "../src/session-transfer.mjs";

const CLAUDE_DIR = join(homedir(), ".claude");
const BUNDLE_DIR = join(homedir(), BUNDLE_DIR_NAME);
const argv = process.argv.slice(2);
const filter = argv.filter((a) => !a.startsWith("-"))[0] ?? null;
// `--host=local` / `--host=<name>`, repeatable. The palette builds these from
// the machine picker; a folder filter is still there for typing by hand. Null
// when none were given, which means every machine — the two are independent,
// so `--host=beast kob` is "beast's kob projects".
const HOST_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const wanted = argv
  .filter((a) => a.startsWith("--host="))
  .map((a) => a.slice(7))
  // Validated even though the picker builds them: this reaches `ssh` as a
  // hostname, and "the caller is trusted" is the assumption that stops being
  // true the first time someone scripts it.
  .filter((h) => h === "local" || HOST_RE.test(h));
const hostFilter = wanted.length ? new Set(wanted) : null;
const wantHost = (host) => !hostFilter || hostFilter.has(host ?? "local");

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

const matches = (s) =>
  wantHost(s.host) && (!filter || s.folder.includes(filter) || s.cwd.includes(filter));

// Nested sessions have no session of their own to resume — an Agent-tool
// subagent runs inside its parent and an SDK one was started by a script — so
// restoring either would open something nobody opened. They still travel, as
// their parent's `subagents/` directory.
const local = (await getLiveSessions()).filter((s) => !s.nested && !s.host && matches(s));

/**
 * A remote host's sessions come from the file the daemon publishes, not from a
 * read of our own: attaching a session to a window is `matchFolder` plus the
 * IDE locks, and for a remote host it is that *plus* a tree fetched over ssh —
 * a join the daemon has already done and this script has no business redoing.
 * The honest cost is that saving a remote session needs the daemon running,
 * which is said out loud rather than discovered.
 */
let published = [];
try {
  published = JSON.parse(await readFile(join(CLAUDE_DIR, "streamdeck-sessions.json"), "utf8"));
} catch {
  // No daemon, or none that has published yet. Local sessions are unaffected.
}
const remote = published.filter((s) => s.host && matches(s));
const sessions = [...local, ...remote.map((s) => ({ ...s, session_id: s.id }))];

if (sessions.length === 0) {
  const what = [filter && `"${filter}"`, hostFilter && `on ${[...hostFilter].join(", ")}`].filter(Boolean).join(" ");
  console.log(what ? `No sessions matching ${what}.` : "No sessions to save.");
  process.exit(0);
}

const now = Date.now();
const name = bundleName(now);
const staging = join(BUNDLE_DIR, `.${name}.staging`);
await mkdir(BUNDLE_DIR, { recursive: true, mode: DIR_MODE });
await chmod(BUNDLE_DIR, DIR_MODE).catch(() => {});
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "sessions"), { recursive: true, mode: DIR_MODE });

// A remote host's transcripts are fetched whole, once per host, into a local
// mirror of that host's ~/.claude — after which everything below reads from a
// directory and does not care which machine it came from. The poll never
// fetches these (it takes 64KB tails; a bundle needs the file), which is why
// this is its own call and its own scratch tree rather than a read of the
// daemon's.
const fetchRoot = `/tmp/streamdeck-save-${process.pid}`;
// The ControlPath is a socket bind, so the directory has to exist before ssh
// runs — and it lives under /tmp rather than os.tmpdir() for the reason
// remote-fs.mjs records: macOS's per-user temp path is long enough to hit the
// ~104-byte sockaddr limit, and every fetch then fails as "host unreachable"
// with nothing pointing at the real cause.
const roots = new Map();
const unreachable = [];
const byHost = new Map();
for (const s of sessions.filter((x) => x.host)) {
  if (!byHost.has(s.host)) byHost.set(s.host, []);
  byHost.get(s.host).push(s);
}
if (byHost.size) await mkdir(fetchRoot, { recursive: true, mode: 0o700 });
for (const [host, group] of byHost) {
  const paths = [];
  for (const s of group) {
    // projectSlug flattens every non-alphanumeric to a dash, so a cwd from
    // another machine's registry cannot become a traversal here however it was
    // spelled — and tar refuses absolute and `..` members on extract besides.
    const slug = projectSlug(s.cwd);
    paths.push(`projects/${slug}/${s.session_id}.jsonl`, `projects/${slug}/${s.session_id}/subagents`, `projects/${slug}/memory`);
  }
  process.stdout.write(`  fetching ${group.length} session${group.length === 1 ? "" : "s"} from ${host}… `);
  const dest = join(fetchRoot, host);
  const ok = await fetchWholeFiles(host, join(fetchRoot, "cm-%h"), [...new Set(paths)], dest);
  console.log(ok ? "ok" : "failed");
  if (ok) roots.set(host, dest);
  else unreachable.push(host);
}

/** Which local directory stands in for this session's `~/.claude`. */
const rootFor = (s) => (s.host ? roots.get(s.host) : CLAUDE_DIR);

let copied = 0;
let bytes = 0;
let agents = 0;
const saved = [];

for (const s of sessions) {
  const root = rootFor(s);
  if (!root) continue; // its host could not be reached; already reported
  const slug = projectSlug(s.cwd);
  const transcript = join(root, "projects", slug, `${s.session_id}.jsonl`);
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
  const subs = join(root, "projects", slug, s.session_id, "subagents");
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

// Per-project memory, once per distinct (host, cwd) rather than once per
// session — two machines can hold the same path, and one memory directory must
// not stand in for the other's.
let memories = 0;
for (const project of buildManifest(saved, now, null).projects) {
  const root = project.host ? roots.get(project.host) : CLAUDE_DIR;
  if (!root) continue;
  const dir = join(root, "projects", project.slug, "memory");
  if (!(await exists(dir))) continue;
  await cp(dir, join(staging, "memory", memoryDirName(project)), { recursive: true });
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
await rm(fetchRoot, { recursive: true, force: true });

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`Saved ${copied} session${copied === 1 ? "" : "s"} (${mb(bytes)} MB of history${
  agents ? `, ${agents} subagent transcript${agents === 1 ? "" : "s"}` : ""
}${memories ? `, ${memories} project memor${memories === 1 ? "y" : "ies"}` : ""})`);
console.log(`  ${archive}  (${mb((await stat(archive)).size)} MB)`);
for (const s of saved) {
  console.log(`  · ${s.host ? `${s.host}:` : ""}${s.folder.split("/").filter(Boolean).pop()} — ${s.title ?? s.session_id.slice(0, 8)}`);
}
// Named rather than left to be noticed by a short list — a bundle silently
// missing a machine is the one failure worth being loud about.
for (const host of unreachable) console.error(`  ! ${host} could not be reached — none of its sessions are in this bundle`);
console.log(`\nCopy it to the other machine and run:  npm run sessions:restore -- ${name}.tgz`);
