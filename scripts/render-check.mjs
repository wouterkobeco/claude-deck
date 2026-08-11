// Verifies the SVG -> raster pipeline without a physical device attached.
// Run: node scripts/render-check.mjs
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { renderKey } from "../src/render.mjs";

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

// Nested-session indicator: a count that fits inside the column, and one
// large enough to force the overflow-flash square.
for (const [name, nestedCount] of [
  ["small", 4],
  ["overflow", 25],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "kob-backend",
    accent: "#4fc3f7",
    project: "kob-backend",
    nestedCount,
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
  nestedCount: 6,
});
if (marginBuf.length !== expected) {
  console.error(`FAILED (label margin): expected ${expected} bytes, got ${marginBuf.length}`);
  process.exit(1);
}
await sharp(marginBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-margin.png", import.meta.url).pathname);

console.log("OK: nested indicator, overlay tile, margin-reserved wrapping");
