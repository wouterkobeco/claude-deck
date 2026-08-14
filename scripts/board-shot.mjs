// Renders the four boards as PNGs for the README, from made-up sessions —
// same render functions the daemon draws with, no device needed.
// Run: node scripts/board-shot.mjs   (writes docs/img/board-*.png)
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import {
  renderKey,
  renderBlank,
  renderUsage,
  renderAttention,
  renderStat,
  renderTask,
  renderBack,
  renderCompacting,
  splitLabel,
} from "../src/render.mjs";

const W = 72;
const SCALE = 3; // keys are 72px; nearest-neighbour upscale keeps the deck's look
const GAP = 10;
const PAD = 14;

const outDir = new URL("../docs/img/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const A = { api: "#4fc3f7", web: "#ff8a65", orders: "#ba68c8", docs: "#fff176", infra: "#4db6ac" };

// Round the corners the way the physical key faces are rounded.
const mask = Buffer.from(
  `<svg width="${W}" height="${W}"><rect width="${W}" height="${W}" rx="8" fill="#fff"/></svg>`
);

async function board(name, tiles) {
  const keys = await Promise.all(
    Array.from({ length: 15 }, async (_, i) => {
      const buf = await (tiles[i] ?? (({ width, height }) => renderBlank({ width, height })))({ width: W, height: W });
      return sharp(buf, { raw: { width: W, height: W, channels: 4 } })
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer();
    })
  );

  const width = PAD * 2 + 5 * W + 4 * GAP;
  const height = PAD * 2 + 3 * W + 2 * GAP;
  const path = `${outDir}board-${name}.png`;
  // Two passes: sharp composites after resizing, so the grid is built at 1x
  // and only then upscaled.
  const grid = await sharp({ create: { width, height, channels: 4, background: "#141414" } })
    .composite(
      keys.map((input, i) => ({
        input,
        left: PAD + (i % 5) * (W + GAP),
        top: PAD + Math.floor(i / 5) * (W + GAP),
      }))
    )
    .png()
    .toBuffer();
  await sharp(grid).resize(width * SCALE, height * SCALE, { kernel: "nearest" }).png().toFile(path);
  console.log(`wrote ${path}`);
}

const key = (params) => (geom) => renderKey({ ...geom, ...params });
const stat = (label, value) => (geom) => renderStat({ ...geom, label, value });
const task = (number, subject, status) => (geom) => renderTask({ ...geom, number, subject, status });

// --- sessions board: the normal view ---------------------------------------
await board("sessions", [
  key({ state: "busy", label: "retry webhooks", accent: A.api, project: "acme-api", progress: { current: 3, total: 7 }, context: 41, nestedStates: ["busy", "idle"] }),
  key({ state: "requires_action", label: "rename UserToken", accent: A.api, project: "acme-api", context: 62 }),
  key({ state: "waiting", label: "checkout keyboard nav", accent: A.web, project: "acme-web", context: 18 }),
  key({ state: "busy", label: "price formatter", accent: A.web, project: "acme-web", progress: { current: 2, total: 4 }, context: 77 }),
  key({ state: "shell", label: "tail consumer logs", accent: A.orders, project: "orders-svc", context: 33, shell: true }),
  key({ state: "idle", label: "refund edge cases", accent: A.orders, project: "orders-svc", context: 88 }),
  (geom) => renderCompacting({ ...geom, accent: A.docs, project: "docs-site", phase: 0.25 }),
  key({ state: "busy", label: "API reference", accent: A.docs, project: "docs-site", progress: { current: 5, total: 9 }, context: 52 }),
  key({ state: "idle", label: "terraform drift", accent: A.infra, project: "infra", context: 24 }),
  null, null, null, null,
  (geom) => renderAttention({ ...geom, count: 2, longest: "14m" }),
  (geom) => renderUsage({ ...geom, session: 63, week: 41 }),
]);

// --- detail board: one session across all 15 keys --------------------------
const [titleA, titleB] = splitLabel("retry webhooks", 2);
await board("detail", [
  key({ state: "busy", label: titleA, accent: A.api, project: "" }),
  key({ state: "busy", label: titleB, accent: A.api, project: "" }),
  stat("STATE", "busy 12m"),
  stat("CONTEXT", "41%"),
  stat("MODEL", "opus-5 high"),
  task(1, "reproduce the dropped delivery", "completed"),
  task(2, "add the retry queue table", "completed"),
  task(3, "exponential backoff with jitter", "in_progress"),
  task(4, "dead-letter after 5 attempts", "pending"),
  task(5, "backfill the failed deliveries", "pending"),
  (geom) => renderBack(geom),
  key({ state: "busy", label: "audit signatures", accent: A.api, project: "hardening-wt" }),
  key({ state: "requires_action", label: "migration test", accent: A.api, project: "queue-wt" }),
  null,
  null,
]);

// --- attention board: only what is blocked, worst first --------------------
await board("attention", [
  key({ state: "requires_action", label: "rename UserToken", accent: A.api, project: "acme-api", context: 62 }),
  // A worktree session on this board still says its project — the caps bar is
  // always the matched window's folder, never the session's own cwd.
  key({ state: "requires_action", label: "migration test", accent: A.api, project: "acme-api" }),
  key({ state: "waiting", label: "checkout keyboard nav", accent: A.web, project: "acme-web", context: 18 }),
  null, null, null, null, null, null, null, null, null, null,
  (geom) => renderAttention({ ...geom, count: 3, longest: "14m" }),
  (geom) => renderUsage({ ...geom, session: 63, week: 41 }),
]);

// --- stats board: the usage key's second press -----------------------------
await board("stats", [
  stat("Session reset", "3h"),
  stat("Week reset", "4d"),
  stat("Favorite model", "Opus 5"),
  stat("Total tokens", "412.6M"),
  stat("Sessions", "1,284"),
  stat("Active days", "96/121"),
  stat("Most active day", "Aug 4"),
  stat("Input tokens", "8.1M"),
  stat("Output tokens", "3.4M"),
  stat("Version", "v1.1.15"),
  renderBack,
  null,
  null,
  (geom) => renderAttention({ ...geom, count: 2, longest: "14m" }),
  (geom) => renderUsage({ ...geom, session: 63, week: 41 }),
]);
