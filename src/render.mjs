import sharp from "sharp";

const BUSY = "#2e7d32"; // green — actively working

// Keyed by the session registry's own status vocabulary.
export const STATE_COLORS = {
  busy: BUSY,
  // `shell` is "turn over, but a background shell it started is still
  // running" — work in flight either way, so it reads as busy rather than as
  // its own colour. What it isn't is the margin square's job, below.
  shell: BUSY,
  requires_action: "#c62828", // red — blocked on you
  // Dark gold, not the bright amber this used to be. Every background here has
  // to carry white body text and the bright marker squares below; at #e6a700
  // (L* 73) that text was 2.1:1 and the markers 1.3:1 — the one key on the
  // board where the light-on-dark rule the rest of the palette follows broke.
  // This sits at L* 47 with the others (36–46), keeps ≥53 ΔE from all three,
  // and gives white 5.0:1.
  waiting: "#886000", // dark gold — waiting on input
  idle: "#555555", // gray
};

// Colours for the nested-session squares, and for the shell marker. Deliberately
// brighter than STATE_COLORS: those are key backgrounds and are dark by design,
// so a busy square drawn in the busy background colour would disappear into a
// busy key.
export const MARKER_COLORS = {
  busy: "#69f0ae",
  waiting: "#ffc107",
  // Pale rather than the #ff5252 the pulse uses: red is the darkest hue at any
  // given saturation, and at #ff5252 this square measured 1.6:1 on the busy key
  // — the marker for "a subagent here is blocked on you" was the least visible
  // one on the board. #ffa4a4 is as light as red goes before it stops reading
  // as red at 3×6px (it's 43 ΔE from the white idle marker; much lighter and
  // they converge). 2.7:1 is the ceiling for this hue, below the 2.9 the rest
  // of the set clears — and the case is partly carried anyway by the key
  // itself, which `mostUrgent` has already turned red and set pulsing.
  requires_action: "#ffa4a4",
  shell: "#90caf9",
  idle: "#ffffff",
};

/**
 * Compact age for a key. Kept short because it shares the accent bar with the
 * project name: seconds below a minute, whole minutes below an hour, h+mm
 * past that. Empty string for anything unusable, so a session whose registry
 * entry carries no timestamp draws no age rather than one counted from 1970.
 */
export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Splits a label into `parts` roughly equal chunks on word boundaries, so a
 * title can run across neighbouring keys. Always returns exactly `parts`
 * strings — short labels leave the later keys blank rather than undefined.
 */
export function splitLabel(label, parts) {
  const words = (label ?? "").split(/\s+/).filter(Boolean);
  const out = new Array(parts).fill("");
  if (words.length === 0) return out;
  const per = Math.ceil(words.length / parts);
  for (let i = 0; i < parts; i++) out[i] = words.slice(i * per, (i + 1) * per).join(" ");
  return out;
}

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/** Splits into fixed-width chunks — no word-boundary awareness, breaks mid-word. */
function wrapLabel(label, width, fontSize) {
  const maxChars = Math.max(3, Math.floor(width / (fontSize * 0.6)));
  const lines = [];
  for (let i = 0; i < label.length; i += maxChars) lines.push(label.slice(i, i + maxChars));
  return lines;
}

/**
 * The foot counter as data: one square per task across the key width, 1px
 * gaps, green once completed. `current` counts the in-progress task, so it
 * only reads as done when nothing is active (`active` null means the counter
 * has moved on to the furthest-along *completed* task).
 *
 * The row is inset by FOOT_MARGIN so the first and last squares don't run into
 * the key's edges — on the left column that edge is the physical bezel, on the
 * right it's the edge of the deck.
 */
const FOOT_MARGIN = 3;

export function taskSquares(progress, width) {
  const n = Math.max(1, progress.total);
  const done = progress.current - (progress.active ? 1 : 0);
  const w = (width - 2 * FOOT_MARGIN - (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({
    x: FOOT_MARGIN + i * (w + 1),
    width: w,
    // The square right after the done run *is* the running one — that's how
    // `done` was derived — so which task is ongoing costs no extra data.
    state: i < done ? "done" : i === done && progress.active ? "active" : "todo",
  }));
}

/** Uppercases a project name and truncates it to what fits the accent bar. */
function fitCaps(project, width, fontSize) {
  // 0.66 covers uppercase + the letter-spacing below; 0.9 keeps a side margin.
  const maxChars = Math.max(3, Math.floor((width * 0.9) / (fontSize * 0.66)));
  const upper = project.toUpperCase();
  return upper.length <= maxChars ? upper : upper.slice(0, maxChars - 1) + "…";
}

/** Renders a solid-color key with a left-aligned, fixed-width-wrapped label. Returns a raw RGBA buffer. */
export async function renderKey({ width, height, state, label, accent, project, progress, context, pulse, nestedStates, shell }) {
  // requires_action is the one state worth flashing — it's the only one
  // that's actually blocked on you, so it's the only one that should chase
  // your eye across the room.
  const color = pulse && state === "requires_action" ? "#ff5252" : STATE_COLORS[state] ?? STATE_COLORS.idle;
  const capSize = Math.round(height * 0.11);
  // Accents are all light, so the caps go dark rather than white. The bar
  // carries the project name alone: an age shared it for one release and
  // there simply isn't room for both at 72px — the detail board's STATE tile
  // is where time-in-state is legible.
  const caps = project ? fitCaps(project, width, capSize) : "";
  // Title zone: 3px of plain accent-coloured pad, an 8px row for the caps
  // text, a 2px dark border on the bottom edge only — 13px fixed, not derived
  // from capSize. The gauge, when known, eats that border rather than adding
  // its own height.
  const titleTopPad = 1;
  const titleBorder = 2;
  const titleTextRow = 8;
  const titleHeight = project
    ? titleTopPad + titleBorder + titleTextRow + titleBorder
    : Math.round(height * 0.12);
  const barHeight = accent ? titleHeight : 0;
  const fontSize = Math.round(height * 0.19);
  // Tighter than typographic ideal so four lines still fit under the bar.
  const lineHeight = fontSize * 1.05;
  const footHeight = progress ? 10 : 0;
  const maxLines = progress ? 3 : 4;

  // Left-margin indicator column: a blue square when a background shell is
  // still running, then one white square per nested (worktree) session
  // sharing this button's project folder — so either kind of hidden
  // background activity shows at a glance. The margin is always reserved,
  // whether or not anything is in it, so a key's body text sits at a
  // consistent left edge across the whole board. When more markers would fit
  // than the column has vertical room for, the last visible one flashes
  // (driven by `pulse`) instead of being dropped.
  const squareWidth = 3;
  const squareHeight = 6;
  const squarePitch = 7; // squareHeight + 1px gap
  const marginWidth = 8;
  const squaresTop = barHeight + 2;
  const squaresBottom = height - footHeight - 2;
  const maxSquares = Math.max(0, Math.floor((squaresBottom - squaresTop) / squarePitch));
  // `state` is the whole block's — it goes green when a subsession behind
  // this key is working — so the blue shell marker takes an explicit flag
  // about *this* session. Falls back to state for callers that don't pass it
  // (the queue and detail boards, which draw one session per key).
  const shellDot = shell ?? state === "shell";
  const nested = nestedStates ?? [];
  const totalMarkers = (shellDot ? 1 : 0) + nested.length;
  const visibleMarkers = Math.min(totalMarkers, maxSquares);
  const overflowMarker = totalMarkers > maxSquares;
  // Shell marker first (it's about this session itself), nested markers
  // after (children of it) — trimmed to what actually fits. A nested marker
  // carries its own session's state as its colour: those sessions have no key
  // of their own, so this square is the only place their state can show. The
  // shell marker draws in the same light blue as a nested session in shell
  // state — it used to have its own dark #1565c0, which measured 1.0–1.3:1
  // against the three dark key backgrounds, i.e. invisible on the red one.
  // Same concept, so: same colour, same alphas.
  const markers = [
    ...(shellDot ? [MARKER_COLORS.shell] : []),
    ...nested.map((st) => MARKER_COLORS[st] ?? MARKER_COLORS.idle),
  ].slice(0, visibleMarkers);
  const squares = markers
    .map((fill, i) => {
      const dimmed = i === visibleMarkers - 1 && overflowMarker && !pulse;
      return `<rect x="3" y="${squaresTop + i * squarePitch}" width="${squareWidth}" height="${squareHeight}" fill="${fill}${
        dimmed ? "33" : "ee"
      }" />`;
    })
    .join("");

  // The label's wrap width and left edge both make room for the margin
  // column above — not just drawn on top of it — so a long line can't run
  // through the squares.
  const textWidth = width - marginWidth;
  const textLeftX = marginWidth + 3;

  // Lowercase body against the header's uppercase caps, so the two rows read
  // as distinct typographic levels rather than fighting for the same weight.
  let lines = wrapLabel(label.toLowerCase(), textWidth, fontSize);
  if (lines.length > maxLines) {
    // aiTitle can be a full sentence; anything past what the key can show
    // vertically gets cut, with the last visible line ellipsized.
    const maxChars = Math.max(3, Math.floor(textWidth / (fontSize * 0.6)));
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)) + "…";
  }

  // Top-align the body under the accent bar, regardless of how many lines
  // there are — a short label sits flush at the top rather than centered in
  // the leftover space, so every key's text starts at the same height.
  const bodyTop = barHeight;
  const startY = bodyTop + 2 + lineHeight / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="${textLeftX}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      ${accent ? `<rect width="${width}" height="${titleHeight}" fill="${accent}" />` : ""}
      ${
        // The lower border doubles as the context gauge when known — plain
        // dark line otherwise. Keeps the header a constant height either way.
        // The coloured fill is inset 1px so a line of the dark track always
        // sits between it and the accent above: drawn flush, the gauge butted
        // straight onto the accent bar at 1.0–1.7:1 for nearly every
        // accent/level pair, and simply wasn't there on some of them. 1px of
        // gauge that reads beats 2px that doesn't; growing the header instead
        // would push a 4-line body off the bottom of the key.
        project
          ? typeof context === "number"
            ? `<rect y="${titleHeight - titleBorder}" width="${width}" height="${titleBorder}" fill="#000000cc" />
               <rect y="${titleHeight - titleBorder + 1}" width="${(width * Math.min(100, Math.max(0, context))) / 100}"
                     height="${gaugeHeight(context)}" fill="${usageColor(context)}" />`
            : `<rect y="${titleHeight - titleBorder}" width="${width}" height="${titleBorder}" fill="#000000aa" />`
          : ""
      }
      ${
        caps
          ? `<text x="50%" y="${titleTopPad + titleBorder + titleTextRow / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.5" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(caps)}</text>`
          : ""
      }
      <text font-family="sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="0.1" fill="#ffffff"
            text-anchor="start" dominant-baseline="middle">${tspans}</text>
      ${squares}
      ${
        progress
          ? taskSquares(progress, width)
              .map(
                (s) =>
                  // Done green, ongoing bright white, still-to-do the same
                  // white at a third opacity. The ongoing one deliberately
                  // doesn't borrow a state hue — amber and green already mean
                  // "waiting" and "busy" elsewhere on the board — so it's the
                  // to-do ink turned all the way up instead.
                  `<rect x="${s.x}" y="${height - 9}" width="${s.width}" height="6" fill="${
                    { done: "#69f0ae", active: "#ffffffcc", todo: "#ffffff33" }[s.state]
                  }" />`
              )
              .join("")
          : ""
      }
    </svg>`;

  return sharp(Buffer.from(svg))
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * Green under half, amber past that, red once a window is nearly spent. Bright
 * enough to read as a few pixels sitting on a light accent colour.
 */
export function usageColor(pct) {
  return pct >= 85 ? "#ff5252" : pct >= 50 ? "#ffc107" : "#69f0ae";
}

/**
 * Gauge thickness in px, keyed to the same thresholds as `usageColor`: 2px
 * green and orange, 4px red. Colour alone is a weak signal at 72px across a
 * room; height is the one that reads peripherally — so height is spent on the
 * one distinction worth catching from across the room (nearly spent vs not),
 * and green/orange are told apart by colour alone. The extra pixels grow
 * *down*, past the header's dark border and onto the key's own background —
 * the header can't get taller without pushing a 4-line body off the key.
 */
export function gaugeHeight(pct) {
  return pct >= 85 ? 4 : 2;
}

/**
 * Usage key: the two rate-limit windows Claude Code's /usage reports, stacked.
 * `session` / `week` are percentages, or null while unknown.
 */
export async function renderUsage({ width, height, session, week }) {
  const half = height / 2;
  const rows = [
    { caps: "SESSION", pct: session, top: 0 },
    { caps: "WEEK", pct: week, top: half },
  ];
  const capSize = Math.round(height * 0.11);
  const pctSize = Math.round(height * 0.26);

  const body = rows
    .map(({ caps, pct, top }) => {
      const known = typeof pct === "number";
      const shown = known ? Math.min(100, Math.max(0, Math.round(pct))) : 0;
      const barY = top + half - 7;
      return `
        <text x="50%" y="${top + half * 0.26}" font-family="sans-serif" font-size="${capSize}"
              font-weight="bold" letter-spacing="0.5" fill="#ffffff99" text-anchor="middle"
              dominant-baseline="middle">${caps}</text>
        <text x="50%" y="${top + half * 0.62}" font-family="sans-serif" font-size="${pctSize}"
              fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${known ? shown + "%" : "—"}</text>
        <rect x="6" y="${barY}" width="${width - 12}" height="4" rx="2" fill="#ffffff22" />
        <rect x="6" y="${barY}" width="${((width - 12) * shown) / 100}" height="4" rx="2"
              fill="${usageColor(shown)}" />`;
    })
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <rect y="${half - 1}" width="${width}" height="1" fill="#ffffff22" />
      ${body}
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * The attention key: how many sessions want you, and how long the worst one
 * has been waiting. Dark and quiet at zero — an empty queue should read as
 * "nothing to do here", not as a key that failed to draw.
 */
export async function renderAttention({ width, height, count, longest, pulse }) {
  const capSize = Math.round(height * 0.11);
  const countSize = Math.round(height * 0.34);
  const quiet = count === 0;
  const bg = quiet ? "#1b1b1b" : pulse ? "#ff5252" : "#c62828";

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${bg}" />
      <text x="50%" y="${height * 0.38}" font-family="sans-serif" font-size="${quiet ? capSize : countSize}"
            font-weight="bold" fill="${quiet ? "#ffffff55" : "#ffffff"}" text-anchor="middle"
            dominant-baseline="middle">${quiet ? "CLEAR" : count}</text>
      ${
        quiet
          ? ""
          : `<text x="50%" y="${height * 0.66}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="0.5" fill="#ffffffcc" text-anchor="middle"
                   dominant-baseline="middle">WAITING</text>
             <text x="50%" y="${height * 0.85}" font-family="sans-serif" font-size="${capSize}"
                   fill="#ffffff99" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(longest ?? "")}</text>`
      }
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * One tile of the all-time stats board (shown in place of the session grid
 * while that view is toggled on). A small caps label over a big value,
 * value wrapped to at most 2 lines.
 */
// `big` is the stats board: its values are short (a duration, a count, a
// version) and the whole key is the number, so it can afford the larger face.
// The detail board's tiles keep the smaller one — "opus-5 high" and "busy 12m"
// wrap at 0.24 and read worse for being louder.
export async function renderStat({ width, height, label, value, big = false }) {
  const capSize = Math.round(height * 0.1);
  const caps = fitCaps(label, width, capSize);
  const valueSize = Math.round(height * (big ? 0.24 : 0.19));

  let lines = wrapLabel(value, width, valueSize);
  if (lines.length > 2) {
    const maxChars = Math.max(3, Math.floor(width / (valueSize * 0.6)));
    lines = lines.slice(0, 2);
    lines[1] = lines[1].slice(0, Math.max(1, maxChars - 1)) + "…";
  }
  const lineHeight = valueSize * 1.1;
  const valueTop = height * 0.62;
  const startY = valueTop - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="50%" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <text x="50%" y="${height * 0.22}" font-family="sans-serif" font-size="${capSize}"
            font-weight="bold" letter-spacing="0.5" fill="#ffffff99" text-anchor="middle"
            dominant-baseline="middle">${escapeXml(caps)}</text>
      <text font-family="sans-serif" font-size="${valueSize}" font-weight="600" fill="#ff8a65"
            text-anchor="middle" dominant-baseline="middle">${tspans}</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

// Done recedes, active is the only bright tile, todo sits between them —
// the board should read as "here" at a glance, not as fourteen equal boxes.
const TASK_COLORS = {
  completed: { bg: "#1b3a1e", text: "#ffffff77" },
  in_progress: { bg: "#2e7d32", text: "#ffffff" },
  pending: { bg: "#1b1b1b", text: "#ffffffaa" },
};

/**
 * One task of the detail board: its number small at the top, its subject
 * wrapped below, coloured by status.
 */
export async function renderTask({ width, height, number, subject, status }) {
  const { bg, text } = TASK_COLORS[status] ?? TASK_COLORS.pending;
  const capSize = Math.round(height * 0.11);
  const fontSize = Math.round(height * 0.17);
  const lineHeight = fontSize * 1.05;

  let lines = wrapLabel((subject ?? "").toLowerCase(), width - 6, fontSize);
  const maxLines = 4;
  if (lines.length > maxLines) {
    const maxChars = Math.max(3, Math.floor((width - 6) / (fontSize * 0.6)));
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + "…";
  }
  const startY = height * 0.3 + lineHeight / 2;
  const tspans = lines.map((line, i) => `<tspan x="3" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`).join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${bg}" />
      <text x="3" y="${height * 0.13}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="0.5" fill="${text}" dominant-baseline="middle">${number}</text>
      <text font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="${text}"
            text-anchor="start" dominant-baseline="middle">${tspans}</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * A session mid-compaction: a ring that sweeps round with the word under it.
 *
 * `phase` is 0..1 and comes from the pulse loop's tick, not from any real
 * progress — nothing on disk reports how far along a compaction is, only that
 * it finished. So this is a spinner honestly shaped like one: it says "still
 * going", never "56%". Compactions run 70-120s, so it sweeps slowly enough to
 * read as deliberate rather than as a stuck redraw.
 */
export async function renderCompacting({ width, height, accent, project, phase = 0 }) {
  const capSize = Math.round(height * 0.11);
  const cx = width / 2;
  const cy = height * 0.44 + 1;
  const r = Math.round(height * 0.2);
  const stroke = 4;

  // A quarter-turn arc as the moving head, drawn as a dash pattern round the
  // circumference so no trig is needed to place it.
  const circumference = 2 * Math.PI * r;
  const arc = circumference * 0.28;
  const offset = -circumference * phase;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${STATE_COLORS.busy}" />
      ${accent && project ? `<rect width="${width}" height="13" fill="${accent}" />` : ""}
      ${
        project
          ? `<text x="50%" y="7.5" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
                   letter-spacing="0.5" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(fitCaps(project, width, capSize))}</text>`
          : ""
      }
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff33" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${arc} ${circumference - arc}"
              stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})" />
      <text x="50%" y="${height * 0.84}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="0.5" fill="#ffffffdd" text-anchor="middle"
            dominant-baseline="middle">COMPACTING</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * The detail board's way out. That board takes over every key including the
 * usage and attention ones, so this is the only affordance telling you the
 * deck isn't stuck — which is why it's an arrow and a word rather than a
 * glyph alone.
 */
export async function renderBack({ width, height }) {
  const capSize = Math.round(height * 0.11);
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <text x="50%" y="${height * 0.44}" font-family="sans-serif" font-size="${Math.round(height * 0.42)}"
            fill="#ffffffdd" text-anchor="middle" dominant-baseline="middle">←</text>
      <text x="50%" y="${height * 0.78}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="0.5" fill="#ffffff99" text-anchor="middle" dominant-baseline="middle">BACK</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/** Blank/off key, used to clear unassigned slots. */
export async function renderBlank({ width, height }) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .raw()
    .toBuffer();
}
