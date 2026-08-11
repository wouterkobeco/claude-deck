import sharp from "sharp";

const BUSY = "#2e7d32"; // green — actively working

// Keyed by the session registry's own status vocabulary.
const STATE_COLORS = {
  busy: BUSY,
  // `shell` is "turn over, but a background shell it started is still
  // running" — work in flight either way, so it reads as busy rather than as
  // its own colour. What it isn't is the margin square's job, below.
  shell: BUSY,
  requires_action: "#c62828", // red — blocked on you
  waiting: "#e6a700", // amber — waiting on input
  idle: "#555555", // gray
};

const SHELL_DOT = "#1565c0"; // blue — a background shell is still running

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

/** Uppercases a project name and truncates it to what fits the accent bar. */
function fitCaps(project, width, fontSize) {
  // 0.66 covers uppercase + the letter-spacing below; 0.9 keeps a side margin.
  const maxChars = Math.max(3, Math.floor((width * 0.9) / (fontSize * 0.66)));
  const upper = project.toUpperCase();
  return upper.length <= maxChars ? upper : upper.slice(0, maxChars - 1) + "…";
}

/** Renders a solid-color key with a left-aligned, fixed-width-wrapped label. Returns a raw RGBA buffer. */
export async function renderKey({ width, height, state, label, accent, project, progress, context, pulse, nestedCount }) {
  // requires_action is the one state worth flashing — it's the only one
  // that's actually blocked on you, so it's the only one that should chase
  // your eye across the room.
  const color = pulse && state === "requires_action" ? "#ff5252" : STATE_COLORS[state] ?? STATE_COLORS.idle;
  const capSize = Math.round(height * 0.11);
  // Accents are all light, so the caps go dark rather than white.
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
  const progressSize = Math.round(height * 0.19);
  const footHeight = progress ? progressSize * 1.15 : 0;
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
  const shellDot = state === "shell";
  const totalMarkers = (shellDot ? 1 : 0) + (nestedCount ?? 0);
  const visibleMarkers = Math.min(totalMarkers, maxSquares);
  const overflowMarker = totalMarkers > maxSquares;
  // Shell marker first (it's about this session itself), nested markers
  // after (children of it) — trimmed to what actually fits.
  const markers = [...(shellDot ? [true] : []), ...Array(nestedCount ?? 0).fill(false)].slice(0, visibleMarkers);
  const squares = markers
    .map((isShell, i) => {
      const dim = i === visibleMarkers - 1 && overflowMarker && !pulse;
      const fill = isShell ? `${SHELL_DOT}${dim ? "55" : ""}` : `#ffffff${dim ? "33" : "ee"}`;
      return `<rect x="3" y="${squaresTop + i * squarePitch}" width="${squareWidth}" height="${squareHeight}" fill="${fill}" />`;
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

  const done = progress ? Math.round((progress.current / Math.max(1, progress.total)) * width) : 0;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      ${accent ? `<rect width="${width}" height="${titleHeight}" fill="${accent}" />` : ""}
      ${
        // The lower border doubles as the context gauge when known — plain
        // dark line otherwise. Keeps the header a constant height either way.
        project
          ? typeof context === "number"
            ? `<rect y="${titleHeight - titleBorder}" width="${width}" height="${titleBorder}" fill="#000000cc" />
               <rect y="${titleHeight - titleBorder}" width="${(width * Math.min(100, Math.max(0, context))) / 100}"
                     height="${titleBorder}" fill="${usageColor(context)}" />`
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
          ? `<rect y="${height - 3}" width="${width}" height="3" fill="#00000055" />
             <rect y="${height - 3}" width="${done}" height="3" fill="#ffffffcc" />
             <text x="50%" y="${height - footHeight / 2 - 2}" font-family="sans-serif"
                   font-size="${progressSize}" fill="#ffffffdd" text-anchor="middle"
                   dominant-baseline="middle">${progress.current}/${progress.total}</text>`
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
function usageColor(pct) {
  return pct >= 85 ? "#ff5252" : pct >= 50 ? "#ffc107" : "#69f0ae";
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
 * One tile of the all-time stats board (shown in place of the session grid
 * while that view is toggled on). A small caps label over a big value,
 * value wrapped to at most 2 lines.
 */
export async function renderStat({ width, height, label, value }) {
  const capSize = Math.round(height * 0.1);
  const caps = fitCaps(label, width, capSize);
  const valueSize = Math.round(height * 0.19);

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
      <text font-family="sans-serif" font-size="${valueSize}" font-weight="600" fill="#ffab70"
            text-anchor="middle" dominant-baseline="middle">${tspans}</text>
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
