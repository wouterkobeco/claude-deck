// Verifies the SVG -> raster pipeline without a physical device attached.
// Run: node scripts/render-check.mjs
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { renderKey, formatAge, taskSquares, renderAttention, renderFree, renderTask, renderStat, renderBack, renderCompacting, renderIcon, wrapLabel, wrapWords, ellipsize, measureText } from "../src/render.mjs";

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

// Wrapping at the real body-text geometry of a 72px key: 58px of text width
// (11px in from the left for the marker column, 3px back off the right edge),
// fontSize 14, letter-spacing 0.1. Lines are filled by measured width, so a run
// of narrow letters gets far more of them than a run of wide ones — the flat
// 0.6em-per-character estimate this replaced fit neither, and a space landing
// on a line's edge (which draws nothing) cost a whole slot on top of that,
// drawing "projec" / "t packa" on lines with room for "project".
const wrap = (s) => wrapLabel(s, 58, 14, 0.1).join("|");
eq(wrap("upgrade project packages"), "upgrade|project|package|s", "space never costs a slot");
eq(wrap("iiiiiiiiiiiiiiii"), "iiiiiiiiiiiii|iii", "thirteen narrow letters fit");
eq(wrap("mmmmmmmm"), "mmmm|mmmm", "only four wide ones do");
eq(wrap("abcdefg hijk"), "abcdefg|hijk", "still breaks mid-word");
eq(wrap("   "), "", "spaces only");
// A glyph wider than the whole line still gets a line rather than looping.
eq(wrapLabel("mmm", 2, 14).join("|"), "m|m|m", "narrower than one character");

// Stat tiles break at spaces instead: a value is two or three short words, and
// a tile with room for both of "opus-5 high" drew "opus-5 hi" / "gh". Full tile
// width (72px) and renderStat's own value size (round(72 * 0.19) = 14), no
// letter-spacing.
const words = (s) => wrapWords(s, 72, 14).join("|");
eq(words("opus-5 high"), "opus-5|high", "the model and its effort are two facts");
eq(words("Sonnet 4.5"), "Sonnet|4.5", "and so are a name and its version");
eq(words("busy 40m"), "busy 40m", "what already fits is left on one line");
// One word wider than the tile has nowhere to go but mid-word — ellipsizing
// would drop the half that says which state this is.
eq(words("requires_action 2h14m"), "requires_|action|2h14m", "an oversized word still breaks");
eq(words("  "), "", "spaces only");
eq(ellipsize("abcdefghijklmnopq", 58, 14, 0.1), "abcde…", "truncation measures the ellipsis too");

// The table above is only worth having while it still describes the font
// fontconfig actually hands this pipeline. Render a line and compare the
// estimate against the ink it really covers — ink runs a little narrower than
// the advance widths (the first and last glyph's side bearings are outside
// it), so this asserts a band, not equality. A wrong or stale table blows
// straight through it; a re-measured one sits mid-band.
{
  const sample = "upgrade project packages";
  const svg = `<svg width="600" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="40" fill="#000"/>
    <text x="10" y="25" font-family="sans-serif" font-size="14" font-weight="600" letter-spacing="0.1" fill="#fff">${sample}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  let min = Infinity;
  let max = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels] > 40) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  const ink = max - min + 1;
  const ratio = measureText(sample, 14, 0.1) / ink;
  if (!(ratio > 0.98 && ratio < 1.06)) {
    console.error(`FAILED (char width table): estimate/ink = ${ratio.toFixed(3)}, want 0.98-1.06 (ink ${ink}px)`);
    process.exit(1);
  }
}

// The foot counter as squares: total squares across the width with 1px gaps
// and a 3px margin at each end, and `current` only counts as done once nothing
// is active — task 2 running means one square green, task 2 being the furthest
// completed means two.
{
  const sq = taskSquares({ current: 2, total: 5, active: "doing task 2" }, 72);
  eq(sq.length, 5, "one square per task");
  eq(sq.filter((s) => s.state === "done").length, 1, "in-progress task is not done");
  eq(sq[1].state, "active", "the square after the done run is the ongoing one");
  eq(sq[2].state, "todo", "everything past the ongoing one is to-do");
  eq(+(sq[1].x - (sq[0].x + sq[0].width)).toFixed(3), 1, "1px gap between squares");
  eq(sq[0].x, 3, "3px margin before the first square");
  eq(Math.round(sq[4].x + sq[4].width), 69, "3px margin after the last square");
  const idle = taskSquares({ current: 2, total: 5, active: null }, 72);
  eq(idle.filter((s) => s.state === "done").length, 2, "nothing active counts current as done");
  eq(idle.filter((s) => s.state === "active").length, 0, "nothing active means no ongoing square");
}

// A long task list drops the gap rather than growing a second rendering mode:
// at 20 tasks a 1px gap is a third of each square and the row reads as
// hatching, so the squares butt together into a plain two-tone bar. The switch
// is on the geometry, not the count — 13 tasks is the last row whose squares
// still clear 4px with the gaps in, so a wider key would keep them longer.
{
  const gapOf = (n) => {
    const sq = taskSquares({ current: 1, total: n, active: "x" }, 72);
    return +(sq[1].x - (sq[0].x + sq[0].width)).toFixed(3);
  };
  eq(gapOf(13), 1, "13 tasks still fit gapped squares");
  eq(gapOf(14), 0, "14 tasks collapse the gap");
  const wide = taskSquares({ current: 1, total: 20, active: "x" }, 72);
  eq(wide.length, 20, "one square per task, gap or no gap");
  eq(wide[0].x, 3, "gapless row keeps the left margin");
  eq(Math.round(wide[19].x + wide[19].width), 69, "gapless row keeps the right margin");
  eq(wide[0].state, "active", "gapless row still marks the ongoing task");
}

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

// The marker column is reserved only while a marker is in it, so the body
// starts at x=11 on a key with nested activity and at x=3 on one without —
// read straight back off the raster, because an off-by-one here is a word per
// key and is invisible anywhere but the deck. The nested state is `busy`
// (green marker) rather than idle so the only pure-white pixels in the body
// rows are the text itself.
for (const [name, nestedStates, wantLeft] of [
  ["margin reserved", ["busy"], 11],
  ["margin reclaimed", [], 3],
]) {
  const buf = await renderKey({
    width,
    height,
    state: "busy",
    label: "wide open",
    accent: "#4fc3f7",
    project: "kob-backend",
    nestedStates,
  });
  let left = Infinity;
  // Body rows only: below the title bar, above the foot row. Half-lit red is
  // what separates white text from everything else that can appear in those
  // rows — the green marker (r=0x69) and the busy background (r=0x2e) are both
  // under it, and a plain 255 test would land on the second column of an
  // antialiased glyph rather than its first.
  for (let y = 18; y < height - 10; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (buf[p] > 128 && buf[p + 2] > 128 && x < left) left = x;
    }
  }
  eq(left, wantLeft, name);
}

// An empty body says CLEAR (the state after a /clear), centered in the body —
// but only on a real session key. The detail board's title tiles pass
// project:"" and are blank by design on the second key of any short title, so
// they must stay blank. Read off the raster: white ink in the body rows,
// and where its vertical middle sits.
for (const [name, project, wantInk] of [
  ["cleared body", "kob-backend", true],
  ["detail title stays blank", "", false],
]) {
  const buf = await renderKey({ width, height, state: "idle", label: "", accent: "#4fc3f7", project });
  let top = Infinity;
  let bottom = -1;
  for (let y = 18; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (buf[p] > 128 && buf[p + 1] > 128 && buf[p + 2] > 128) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  eq(bottom > -1, wantInk, name);
  // Centered in the body — 13px (under the accent bar) to 72px, so a middle
  // of 42.5, give or take the glyph's own bearings.
  if (wantInk) eq(Math.abs((top + bottom) / 2 - 42.5) <= 3, true, "cleared body centered");
}

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

// The free key, which mirrors the attention key's shape and inverts its
// meaning: BUSY when nothing is spare, a count when something is. Never
// coloured and never pulsed — green already means "working" everywhere else
// here, so a green key for "not working" would fight the palette, and there is
// nothing wrong to alarm about.
for (const [name, count, longest] of [
  ["free-busy", 0, ""],
  ["free-nine", 9, "42m"],
]) {
  const buf = await renderFree({ width, height, count, longest });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

// The status key's busy leg reuses the same shape with label/quietWord
// swapped — WORKING/FREE rather than FREE/BUSY, the same cross-referential
// idiom run the other way.
for (const [name, count, longest] of [
  ["busy-free", 0, ""],
  ["busy-four", 4, "9m"],
]) {
  const buf = await renderFree({ width, height, count, longest, label: "WORKING", quietWord: "FREE" });
  if (buf.length !== expected) {
    console.error(`FAILED (${name}): expected ${expected} bytes, got ${buf.length}`);
    process.exit(1);
  }
  await sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(new URL(`./render-check-${name}.png`, import.meta.url).pathname);
}

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
// The CONTEXT tile draws a ring instead of the text when `pie` is a number —
// 100 is the case worth looking at, being the widest number in the smallest
// hole and the only one that closes the ring completely.
// The stats board draws the same tiles at `big: true` (a larger value size, so
// a word that fits the detail board's tile can overflow this one) — its
// favourite-model tile is the case worth seeing, being the other place a model
// name is drawn.
for (const [name, label, value, pie, big] of [
  ["state-busy", "STATE", "busy 40m"],
  ["state-blocked-longest", "STATE", "requires_action 2h14m"],
  ["context", "CONTEXT", "41%", 41],
  ["context-full", "CONTEXT", "100%", 100],
  ["context-unknown", "CONTEXT", "—"],
  ["model", "MODEL", "opus-5 high"],
  ["model-unknown", "MODEL", "—"],
  ["stats-model", "Favorite model", "Sonnet 4.5", null, true],
]) {
  const buf = await renderStat({ width, height, label, value, pie, big });
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

// The same function draws the config key on the stats board. Glyph coverage is
// not assumed: "⚙" (U+2699) has to survive librsvg and whatever sans-serif
// resolves to here, which is exactly the class of thing this project reads back
// off the raster rather than trusting (see the CHAR_WIDTH case above). Ink in
// the glyph band proves *something* drew; render-check-config.png is what tells
// a human it isn't a tofu box, the same way the other PNGs here work.
const configBuf = await renderBack({ width, height, glyph: "⚙", caps: "CONFIG" });
const blankBuf = await renderBack({ width, height, glyph: " ", caps: "CONFIG" });
// Rows 0 to 65% of the key: the glyph sits at y = height * 0.44 and the caps at
// 0.78, so this band is the glyph's alone.
const inkAbove = (buf) => {
  let n = 0;
  for (let y = 0; y < Math.round(height * 0.65); y++) {
    for (let x = 0; x < width; x++) {
      if (buf[(y * width + x) * 4] > 40) n++;
    }
  }
  return n;
};
const glyphInk = inkAbove(configBuf) - inkAbove(blankBuf);
if (glyphInk < 40) {
  console.error(`FAILED (config key glyph): only ${glyphInk}px of ink above the caps — did ⚙ resolve?`);
  process.exit(1);
}
await sharp(configBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-config.png", import.meta.url).pathname);


// The home-screen icon: nine keys on a dark ground, at whatever size a
// platform asks for. Checked for what actually breaks — a size that isn't
// square, or a renderer that quietly returns nothing.
// eq here compares by identity, so one assertion per scalar rather than an
// array that could never match itself.
for (const size of [180, 192, 512]) {
  const meta = await sharp(await renderIcon(size)).metadata();
  eq(meta.format, "png", `icon-${size} is a png, the only thing iOS takes here`);
  eq(meta.width, size, `icon-${size} is that wide`);
  eq(meta.height, size, `icon-${size} is square`);
}

console.log("OK: nested indicator, overlay tile, margin-reserved wrapping, shell dot, task tiles, detail header tiles, free key, back key, compacting spinner, home-screen icon");
