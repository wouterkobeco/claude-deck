// Verifies the SVG -> raster pipeline without a physical device attached.
// Run: node scripts/render-check.mjs
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { renderKey, formatAge, fitProgress, renderAttention, renderTask, renderStat, renderBack, renderCompacting, splitLabel } from "../src/render.mjs";

const eq = (got, want, label) => {
  if (got !== want) {
    console.error(`FAILED (${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
};

// Compact age for the detail board's STATE tile — it no longer shares the
// accent bar with the project name (there wasn't room for both at 72px), so
// seconds below a minute, whole minutes below an hour, h+mm past that.
eq(formatAge(0), "0s", "zero seconds");
eq(formatAge(45), "45s", "under a minute");
eq(formatAge(60), "1m", "exactly a minute");
eq(formatAge(3599), "59m", "under an hour");
eq(formatAge(3600), "1h00m", "exactly an hour");
eq(formatAge(8040), "2h14m", "hours and minutes");
// A session with no usable timestamp must render nothing rather than an age
// counted from the epoch — sessions.mjs falls back to 0 when the registry
// carries neither statusUpdatedAt nor updatedAt.
eq(formatAge(-1), "", "negative input");
eq(formatAge(NaN), "", "non-numeric input");

// The foot counter's three fit tiers at key size (72px, 14px font): the word
// intact, the vowel dropped, then a smaller font — in that order, because
// "task 2/5" must never shrink just to make room "task 12/20" would need.
eq(JSON.stringify(fitProgress({ current: 2, total: 5 }, 72, 14)), '{"text":"task 2/5","size":14}', "narrow count keeps the word");
eq(JSON.stringify(fitProgress({ current: 12, total: 20 }, 72, 14)), '{"text":"tsk 12/20","size":13}', "wide count drops the vowel first");
eq(JSON.stringify(fitProgress({ current: 123, total: 456 }, 72, 14)), '{"text":"tsk 123/456","size":10}', "very wide count shrinks the font");

const width = 72;
const height = 72;
const buf = await renderKey({
  width,
  height,
  state: "busy",
  label: "prescription-rounds-pr3",
  accent: "#4fc3f7",
  project: "claude-streamdeck",
  progress: { current: 2, total: 5 },
  context: 74,
});

const expected = width * height * 4;
if (buf.length !== expected) {
  console.error(`FAILED: expected ${expected} bytes, got ${buf.length}`);
  process.exit(1);
}

const outPath = new URL("./render-check-output.png", import.meta.url).pathname;
await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
console.log(`OK: wrote ${outPath}`);

// Nested-session indicator: a set that fits inside the column, one large
// enough to force the overflow-flash square, and one mixing every state so
// each marker colour is exercised — a nested session has no key of its own,
// so its square is the only place its state shows.
for (const [name, nestedStates] of [
  ["small", ["idle", "idle", "idle", "idle"]],
  ["overflow", Array(25).fill("idle")],
  ["states", ["busy", "waiting", "requires_action", "shell", "idle"]],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "kob-backend",
    accent: "#4fc3f7",
    project: "kob-backend",
    nestedStates,
  });
  if (buf.length !== expected) {
    console.error(`FAILED (nested ${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-nested-${name}.png`, import.meta.url).pathname);
}

// Worktree tile on the detail board: caps show the worktree folder's own
// basename, not the parent project's — the parent's name is already on the
// header keys. Same renderKey call refreshDetail's nested tiles make.
const overlayBuf = await renderKey({
  width,
  height,
  state: "idle",
  label: "review transcript signals",
  accent: "#4fc3f7",
  project: "ai-code-detection",
});
if (overlayBuf.length !== expected) {
  console.error(`FAILED (overlay tile): expected ${expected} bytes, got ${overlayBuf.length}`);
  process.exit(1);
}
await sharp(overlayBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-overlay.png", import.meta.url).pathname);

// A long label plus nested squares together: the label must wrap inside the
// reserved margin instead of centering across the full key width.
const marginBuf = await renderKey({
  width,
  height,
  state: "busy",
  label: "a very long aiTitle that would otherwise span the full key width",
  accent: "#4fc3f7",
  project: "kob-backend",
  nestedStates: Array(6).fill("idle"),
});
if (marginBuf.length !== expected) {
  console.error(`FAILED (label margin): expected ${expected} bytes, got ${marginBuf.length}`);
  process.exit(1);
}
await sharp(marginBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-margin.png", import.meta.url).pathname);

// Background-shell state: busy green, blue dot bottom-left in the reserved
// foot row — alone, and sharing that row with the task counter on the right.
for (const [name, progress] of [
  ["shell", null],
  ["shell-progress", { current: 3, total: 7 }],
  ["shell-progress-wide", { current: 12, total: 20 }],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "shell",
    label: "run quality tests on beast container",
    accent: "#4fc3f7",
    project: "kob-backend",
    progress,
    context: 41,
  });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

// Attention key at rest, under load, and mid-pulse. Zero is a distinct
// visual state, not a red key showing "0"; the pulse case covers the
// brighter #ff5252 branch, otherwise unexercised by any check.
for (const [name, count, longest, pulse] of [
  ["attention-clear", 0, "", false],
  ["attention-two", 2, "14m", false],
  ["attention-pulse", 2, "14m", true],
]) {
  const buf = await renderAttention({ width, height, count, longest, pulse });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

// A detail board's title runs across two keys, so the split must always
// return exactly as many pieces as there are keys to fill — a short or empty
// title leaves the later key blank rather than drawing "undefined".
eq(splitLabel("serializing client-block mutations", 2).join("|"), "serializing client-block|mutations", "splits on words");
eq(splitLabel("one", 2).join("|"), "one|", "short label leaves the second key blank");
eq(splitLabel("", 2).length, 2, "empty label still fills every part");
eq(splitLabel(null, 2).join("|"), "|", "missing label is not a crash");
eq(splitLabel("a b c d e", 2).join("|"), "a b c|d e", "odd word counts favour the first key");

// One task tile per status — the three must be tellable apart at arm's length.
for (const status of ["completed", "in_progress", "pending"]) {
  const buf = await renderTask({ width, height, number: 3, subject: "serialize client-block mutations", status });
  if (buf.length !== expected) {
    console.error(`FAILED (task ${status}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-task-${status}.png`, import.meta.url).pathname);
}

// The detail board's STATE/CONTEXT/MODEL stat tiles — renderStat is only
// ever called through refreshDetail, never directly by any check until now.
// "requires_action" plus the longest age format (h+mm) is the longest string
// the board ever puts in one of these.
for (const [name, label, value] of [
  ["state-busy", "STATE", "busy 40m"],
  ["state-blocked-longest", "STATE", "requires_action 2h14m"],
  ["context", "CONTEXT", "41%"],
  ["context-unknown", "CONTEXT", "—"],
  ["model", "MODEL", "opus-5 high"],
  ["model-unknown", "MODEL", "—"],
]) {
  const buf = await renderStat({ width, height, label, value });
  if (buf.length !== expected) {
    console.error(`FAILED (stat ${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-stat-${name}.png`, import.meta.url).pathname);
}

// The detail board's title spans two keys with no accent bar at all
// (`project: ""`, refreshDetail's header tiles) — every renderKey case above
// passes a real project name, so this shape was never rendered by a check.
for (const [name, label] of [
  ["title-a", "serializing client-block"],
  ["title-b", "mutations"],
  ["title-empty", ""],
]) {
  const buf = await renderKey({ width, height, state: "busy", label, accent: "#4fc3f7", project: "" });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

// A compacting key at four points around its sweep. Nothing on disk reports
// how far along a compaction is — only that it finished — so this is a
// spinner, deliberately: it says "still going", never a percentage.
for (const phase of [0, 0.25, 0.5, 0.75]) {
  const buf = await renderCompacting({ width, height, accent: "#4fc3f7", project: "kob-trace", phase });
  if (buf.length !== expected) {
    console.error(`FAILED (compacting ${phase}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-compacting-${phase}.png`, import.meta.url).pathname);
}

// The detail board's back key. It's the only affordance saying the deck isn't
// stuck — that board covers every key, usage and attention included — so it
// gets an arrow and a word rather than a glyph alone.
const backBuf = await renderBack({ width, height });
if (backBuf.length !== expected) {
  console.error(`FAILED (back key): expected ${expected} bytes, got ${backBuf.length}`);
  process.exit(1);
}
await sharp(backBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-back.png", import.meta.url).pathname);

console.log("OK: nested indicator, overlay tile, margin-reserved wrapping, shell dot, task tiles, detail header tiles, back key, compacting spinner");
