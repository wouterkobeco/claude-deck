// Verifies the arithmetic of moving a session between machines: where each
// piece lands, under what id, and what a transcript looks like once its
// machine-specific fields have been rewritten.
//
// This is the half where being wrong is invisible. A transcript filed under a
// slug that doesn't match its destination cwd doesn't error — `claude
// --resume` simply answers "No conversation found", by which point the machine
// it came from may be off. So the mapping is a pure function and this drives
// it; the two commands under scripts/ only read, write and tar.
// Run: node scripts/session-transfer-check.mjs
import assert from "node:assert/strict";
import {
  buildManifest,
  bundleName,
  isSessionId,
  memoryDirName,
  planRestore,
  projectSlug,
  remapCwd,
  resumeCommand,
  rewriteRecords,
} from "../src/session-transfer.mjs";

const ID_A = "0f45d6bd-2418-4129-816a-f9b9d94cdfad";
const ID_B = "d92aeb14-a2fc-4b82-95cd-ab3db69a7dc0";

// The slug rule, which is the one thing a transfer cannot get wrong: measured
// against the real directory names on this machine.
assert.equal(projectSlug("/Users/wouterd/projects/kob-trace"), "-Users-wouterd-projects-kob-trace");
assert.equal(projectSlug("/home/wouterd/projects/kob-trace"), "-home-wouterd-projects-kob-trace");
assert.equal(
  projectSlug("/Users/wouterd/projects/claude-streamdeck/.claude/worktrees/ctx-fix"),
  "-Users-wouterd-projects-claude-streamdeck--claude-worktrees-ctx-fix",
  "a worktree gets its own slug, which is why cwd and folder are not interchangeable"
);
console.log("OK: projectSlug");

// Prefix substitution, not replacement. A worktree session's cwd sits under
// its window's folder, and flattening it onto the folder would file it where
// its own resume will not look.
assert.equal(remapCwd("/Users/w/p/trace", "/Users/w/p/trace", "/home/w/p/trace"), "/home/w/p/trace");
assert.equal(
  remapCwd("/Users/w/p/trace/.claude/worktrees/x", "/Users/w/p/trace", "/home/w/p/trace"),
  "/home/w/p/trace/.claude/worktrees/x",
  "the suffix that makes it a worktree survives the move"
);
assert.equal(
  remapCwd("/Users/w/p/trace", "/Users/w/p/trace/", "/home/w/p/trace/"),
  "/home/w/p/trace",
  "two spellings of one directory are the same directory — a silent non-match here files a session where resume will not look"
);
// A near-miss that is not actually under the folder: "trace-2" starts with
// "trace" as a string and is a different project entirely.
assert.equal(remapCwd("/Users/w/p/trace-2", "/Users/w/p/trace", "/home/w/p/trace"), null, "a sibling path is not a child");
assert.equal(remapCwd("/somewhere/else", "/Users/w/p/trace", "/home/w/p/trace"), null, "and neither is an unrelated one");
console.log("OK: remapCwd");

// Ids and cwds are rewritten; the records that carry dead absolute paths are
// deliberately left alone, and unparseable lines survive rather than being
// dropped — a transcript's last line is routinely half-written.
{
  const lines = [
    JSON.stringify({ type: "user", sessionId: ID_A, cwd: "/Users/w/p/trace", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", session_id: ID_A, cwd: "/Users/w/p/trace/sub" }),
    JSON.stringify({ type: "file-history-delta", trackingPath: "/private/tmp/whatever/x.html" }),
    '{"half written',
    "",
  ];
  const out = rewriteRecords(lines, {
    newId: ID_B,
    cwdFor: (c) => remapCwd(c, "/Users/w/p/trace", "/home/w/p/trace"),
  });
  const a = JSON.parse(out[0]);
  const b = JSON.parse(out[1]);
  assert.equal(a.sessionId, ID_B, "sessionId becomes the fresh one");
  assert.equal(a.cwd, "/home/w/p/trace", "and the cwd is the destination's");
  assert.equal(b.session_id, ID_B, "the snake_case spelling too — real transcripts carry both");
  assert.equal(b.cwd, "/home/w/p/trace/sub", "a subdirectory keeps its suffix");
  assert.equal(
    JSON.parse(out[2]).trackingPath,
    "/private/tmp/whatever/x.html",
    "a file-history path is left alone rather than invented: it points at a scratch dir the other machine has not got"
  );
  assert.equal(out[3], '{"half written', "an unparseable line survives — losing one loses a turn");
  assert.equal(out[4], "", "and so does the trailing blank");
  assert.equal(a.message.content, "hi", "everything else is untouched");
}
console.log("OK: rewriteRecords");

// A manifest describes the bundle without anyone having to unpack it, and
// records cwd and folder separately because they genuinely differ.
{
  const m = buildManifest(
    [
      { session_id: ID_A, folder: "/Users/w/p/trace", cwd: "/Users/w/p/trace", title: "fix the thing", subagents: 2 },
      { session_id: ID_B, folder: "/Users/w/p/trace", cwd: "/Users/w/p/trace/.claude/worktrees/x", title: null },
    ],
    Date.parse("2026-08-23T10:52:00Z"),
    "MBP-1336"
  );
  assert.equal(m.version, 1);
  assert.equal(m.host, "MBP-1336");
  assert.equal(m.sessions.length, 2);
  assert.equal(m.sessions[0].subagents, 2);
  assert.equal(m.sessions[1].subagents, 0, "a session with no subagents says so rather than being undefined");
  assert.equal(m.projects.length, 2, "one project entry per distinct cwd — memory is per project directory");
  assert.equal(m.projects[1].slug, projectSlug("/Users/w/p/trace/.claude/worktrees/x"));
}
console.log("OK: buildManifest");

// The plan is computed whole before anything is written, so a mapping that
// cannot be satisfied is a refusal rather than a half-restored machine.
{
  const manifest = buildManifest(
    [
      { session_id: ID_A, folder: "/Users/w/p/trace", cwd: "/Users/w/p/trace", title: "one" },
      { session_id: ID_B, folder: "/Users/w/p/other", cwd: "/Users/w/p/other", title: "two" },
    ],
    Date.now(),
    "src"
  );
  let n = 0;
  const { plan, skipped } = planRestore(manifest, { "/Users/w/p/trace": "/home/w/code/trace" }, () => `fresh-${++n}`);
  assert.equal(plan.length, 1, "only the project that was given a destination is planned");
  assert.equal(plan[0].destCwd, "/home/w/code/trace");
  assert.equal(plan[0].destSlug, "-home-w-code-trace", "and it is filed under the destination's own slug");
  assert.equal(plan[0].newId, "fresh-1", "with a fresh id, never the source's");
  assert.notEqual(plan[0].newId, plan[0].sourceId);
  assert.equal(skipped.length, 1, "the unmapped one is reported rather than guessed at");
  assert.match(skipped[0].why, /no destination folder/);

  // A bundle from a hostile or simply broken machine: the id reaches a shell.
  const bad = { sessions: [{ id: "../../etc/passwd", folder: "/a", cwd: "/a" }] };
  assert.equal(planRestore(bad, { "/a": "/b" }).plan.length, 0, "a non-UUID id is refused, not sanitised");
  assert.throws(() => resumeCommand("x; rm -rf /"), /not a session id/);
  assert.equal(resumeCommand(ID_B), `claude --resume ${ID_B}`);
  assert.equal(isSessionId(ID_A), true);
  assert.equal(isSessionId("nope"), false);
}
console.log("OK: planRestore");

// Sessions saved off a remote host. The bundle has to keep them apart from
// local ones with the same path — `/home/pi/x` exists on two of this project's
// Raspberry Pis, and that is not a hypothetical.
{
  const m = buildManifest(
    [
      { session_id: ID_A, folder: "/home/pi/x", cwd: "/home/pi/x", title: "pi one", host: "192.168.2.6" },
      { session_id: ID_B, folder: "/home/pi/x", cwd: "/home/pi/x", title: "pi two", host: "192.168.2.70" },
    ],
    Date.now(),
    "MBP-1336"
  );
  assert.equal(m.sessions[0].host, "192.168.2.6", "a session records which machine it came off");
  assert.equal(
    m.projects.length,
    2,
    "one path on two hosts is two projects — a slug alone would collapse them and lose one's memory"
  );
  assert.equal(memoryDirName(m.projects[0]), "192.168.2.6@-home-pi-x");
  assert.equal(memoryDirName(m.projects[1]), "192.168.2.70@-home-pi-x");
  assert.notEqual(memoryDirName(m.projects[0]), memoryDirName(m.projects[1]), "and they never share a directory in the bundle");
  // A local project keeps the bare slug, so bundles written before hosts were
  // a thing still find their memory.
  assert.equal(memoryDirName({ slug: "-Users-w-p-trace", host: null }), "-Users-w-p-trace");

  // A remote session restores onto a local path like any other: the host is
  // shown, never used to place it. Placement is the folder mapping's job.
  const { plan } = planRestore(m, { "/home/pi/x": "/Users/w/p/x" }, () => ID_B);
  assert.equal(plan.length, 2, "both restore — they differ by host, not by where they land");
  assert.equal(plan[0].host, "192.168.2.6", "and each says where it came from");
  assert.equal(plan[0].destCwd, "/Users/w/p/x");
  assert.equal(plan[0].destSlug, "-Users-w-p-x");
}
console.log("OK: remote-origin sessions");

assert.equal(bundleName(Date.parse("2026-08-23T10:52:00")), "2026-08-23-1052", "bundle names sort chronologically");
console.log("OK: session transfer");
