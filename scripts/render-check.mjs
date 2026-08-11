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
