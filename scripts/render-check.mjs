// Verifies the SVG -> raster pipeline without a physical device attached.
// Run: node scripts/render-check.mjs
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { renderKey, formatAge } from "../src/render.mjs";

const eq = (got, want, label) => {
  if (got !== want) {
    console.error(`FAILED (${label}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exit(1);
  }
};

// Compact age for the accent bar: it shares 72px with the project name, so
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

// Overlay tile: caps show the worktree folder's own basename, not the
// parent project's name — same renderKey call an overlay tile makes.
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

// The accent bar carries the project name and the age together. A long name
// beside the longest age is where the caps re-fit either truncates sensibly
// or collides — this writes a PNG to look at, byte length can't judge it.
for (const [name, project, age] of [
  ["age-short", "kob-trace", "45s"],
  ["age-long", "claude-streamdeck", "2h14m"],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "serializing client-block mutations",
    accent: "#4fc3f7",
    project,
    age,
  });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

console.log("OK: nested indicator, overlay tile, margin-reserved wrapping, shell dot");
