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
  // Pale rather than a saturated red: red is the darkest hue at any given
  // saturation, and at #ff5252 this square measured 1.6:1 on the busy key
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

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/**
 * Per-character advance widths as a fraction of the font size, so a line is
 * filled to the pixel it actually reaches rather than to a flat average.
 *
 * Measured off this pipeline's own raster, not copied from a spec sheet:
 * fontconfig resolves `sans-serif` + `font-weight: 600` to Helvetica Bold here,
 * and every text this module wraps is that one face. Re-measure by rendering
 * `(cH)*20` against `H*20` and dividing the ink-width difference by the font
 * size — that is where these numbers came from.
 *
 * Anything unlisted falls back to CHAR_WIDTH_DEFAULT (an average lowercase
 * letter): an em dash or a CJK glyph then wraps roughly rather than not at all.
 */
const CHAR_WIDTH_DEFAULT = 0.6;
const CHAR_WIDTH = {};
for (const [w, chars] of [
  [0.29, " Iijl.,:;!|'`"],
  [0.30, "/\\()[]{}"],
  [0.35, "ft-"],
  [0.40, "r"],
  [0.51, "z"],
  [0.57, "aceksvxy0123456789_J"],
  [0.62, "bdghnopquFLTZ"],
  [0.68, "EPSVXY?"],
  [0.73, "ABCDHKNRU"],
  [0.79, "wGOQ"],
  [0.84, "M"],
  [0.90, "m"],
  [0.95, "W"],
  [1.0, "…%@"],
]) {
  for (const c of chars) CHAR_WIDTH[c] = w;
}

const charWidth = (c, fontSize, letterSpacing) => (CHAR_WIDTH[c] ?? CHAR_WIDTH_DEFAULT) * fontSize + letterSpacing;

export function measureText(s, fontSize, letterSpacing = 0) {
  let total = 0;
  for (const c of s) total += charWidth(c, fontSize, letterSpacing);
  return total;
}

/**
 * Fills each line to the width it really reaches — no word-boundary awareness,
 * breaks mid-word.
 *
 * A space at either edge of a line renders as nothing (SVG collapses it), so it
 * must not be charged for: it is held pending and only committed once a
 * non-space follows it *on the same line*. Slicing by a flat character count
 * did neither, and drew "projec" / "t packa" on lines with room for "project".
 */
export function wrapLabel(label, width, fontSize, letterSpacing = 0) {
  const lines = [];
  let line = "";
  let used = 0;
  let pendingSpace = false;
  for (const c of label) {
    if (c === " ") {
      pendingSpace = line !== "";
      continue;
    }
    const w = charWidth(c, fontSize, letterSpacing);
    const gap = pendingSpace ? charWidth(" ", fontSize, letterSpacing) : 0;
    // `line !== ""` is what guarantees progress: a character wider than the
    // whole key still gets a line of its own instead of looping forever.
    if (line !== "" && used + gap + w > width) {
      lines.push(line);
      line = c;
      used = w;
    } else {
      line += (pendingSpace ? " " : "") + c;
      used += gap + w;
    }
    pendingSpace = false;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The same fit, broken at spaces instead of mid-word.
 *
 * A stat tile's value is two or three short words ("opus-5 high", "busy 40m") —
 * two whole words stacked read as two facts, while `wrapLabel` splitting the
 * second one into "hi" / "gh" reads as neither. A word wider than the tile on
 * its own still breaks mid-word (`requires_action` is one word and 15
 * characters): there is nothing else to do with it, and ellipsizing would throw
 * away the half that says what state the session is in.
 *
 * Not used for key bodies, which are sentences: a title wrapped on spaces
 * leaves a ragged right edge on a 72px key, where the point is filling every
 * line.
 */
export function wrapWords(text, width, fontSize, letterSpacing = 0) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && measureText(`${last} ${word}`, fontSize, letterSpacing) <= width) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else if (measureText(word, fontSize, letterSpacing) <= width) {
      lines.push(word);
    } else {
      // Doesn't fit any line whole — hand this one word back to the character
      // fit, which is what it was written for.
      lines.push(...wrapLabel(word, width, fontSize, letterSpacing));
    }
  }
  return lines;
}

// Shared by each text's `letter-spacing` attribute and by the width budget
// wrapLabel/fitCaps spend against it — the fit is only exact while they agree.
const BODY_LETTER_SPACING = 0.1;
const CAPS_LETTER_SPACING = 0.5;

/** Truncates to what fits `width` with a trailing ellipsis, measured the same way. */
export function ellipsize(line, width, fontSize, letterSpacing = 0) {
  const budget = width - charWidth("…", fontSize, letterSpacing);
  let out = "";
  let used = 0;
  for (const c of line) {
    const w = charWidth(c, fontSize, letterSpacing);
    if (used + w > budget) break;
    out += c;
    used += w;
  }
  // A width too narrow for even one character plus the ellipsis still has to
  // show *something* about the line it stands for.
  return (out || line.slice(0, 1)) + "…";
}

/**
 * The foot counter as data: one square per task across the key width, 1px
 * gaps that collapse once the squares get thin, green once completed.
 * `current` counts the in-progress task, so it only reads as done when
 * nothing is active (`active` null means the counter
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
  const room = width - 2 * FOOT_MARGIN;
  // Past ~16 tasks the 1px gap is a third of each square and the row reads as
  // hatching rather than a fill level. Below 4px the gap is dropped and the
  // same squares butt together into a plain two-tone bar — one boundary, still
  // exactly where it was. No second rendering mode, no threshold on the task
  // count: the geometry decides, so a wider key keeps its squares longer.
  const gap = (room - (n - 1)) / n >= 4 ? 1 : 0;
  const w = (room - (n - 1) * gap) / n;
  return Array.from({ length: n }, (_, i) => ({
    x: FOOT_MARGIN + i * (w + gap),
    width: w,
    // The square right after the done run *is* the running one — that's how
    // `done` was derived — so which task is ongoing costs no extra data.
    state: i < done ? "done" : i === done && progress.active ? "active" : "todo",
  }));
}

/** Uppercases a project name and truncates it to what fits the accent bar. */
function fitCaps(project, width, fontSize) {
  const budget = width * 0.9; // keeps a side margin
  const upper = project.toUpperCase();
  return measureText(upper, fontSize, CAPS_LETTER_SPACING) <= budget
    ? upper
    : ellipsize(upper, budget, fontSize, CAPS_LETTER_SPACING);
}

/** Renders a solid-color key with a left-aligned, fixed-width-wrapped label. Returns a raw RGBA buffer. */
// `contextPhase` is where in its slow breath a red context gauge sits, 0–1,
// advanced by pulse(). Every other caller leaves it at 0 — the steady frame is
// the brightest one, so a board that never pulses looks the same as it always
// did.
export async function renderKey({ width, height, state, label, accent, project, progress, context, pulse, contextPhase = 0, nestedStates, shell }) {
  // requires_action is the one state worth flashing — it's the only one
  // that's actually blocked on you, so it's the only one that should chase
  // your eye across the room. It never actually sits on its own red
  // (STATE_COLORS.requires_action, kept only for colors-check's contrast
  // sweep): it sits on waiting's own dark gold and briefly lifts to bright
  // gold on `pulse` (the blip index.mjs's `actionBright` drives), so at rest
  // it reads as the same "blocked on you" family as waiting, and the flash
  // is a lift within that family rather than a colour fighting a grey.
  const color =
    state === "requires_action"
      ? pulse
        ? "#ffc107"
        : STATE_COLORS.waiting
      : STATE_COLORS[state] ?? STATE_COLORS.idle;
  const capSize = Math.round(height * 0.11);
  // Accents are all light, so the caps go dark rather than white. The bar
  // carries the project name alone: an age shared it for one release and
  // there simply isn't room for both at 72px — the detail board's STATE tile
  // is where time-in-state is legible.
  const caps = project ? fitCaps(project, width, capSize) : "";
  // Title zone: 3px of plain accent-coloured pad, an 8px row for the caps
  // text, a dark border on the bottom edge only — 14px fixed, not derived
  // from capSize. The gauge, when known, eats that border rather than adding
  // its own height.
  const titleTopPad = 1;
  const titleBorder = 2;
  const titleTextRow = 8;
  // The bottom border is the gauge's slot, and it is one pixel deeper than the
  // border above the caps: the gauge is the smallest thing on the board that
  // has to be read across a room, so the pixel buys more there than it does as
  // the 4th body line's bottom margin. That's the whole trade — the header is
  // 14 rather than 13 and the body starts a pixel lower, on every key rather
  // than only the ones reporting context, or bodies would sit at two different
  // heights across the board.
  const gaugeTrack = titleBorder + 1;
  const titleHeight = project
    ? titleTopPad + titleBorder + titleTextRow + gaugeTrack
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
  // background activity shows at a glance. The column is reserved only when
  // something is actually in it — see the body text below. When more markers
  // would fit than the column has vertical room for, the last visible one
  // flashes (driven by `pulse`) instead of being dropped.
  const squareWidth = 3;
  const squareHeight = 6;
  const squarePitch = 7; // squareHeight + 1px gap
  const marginWidth = 8;
  // 5px under the accent bar, not 2: the body's first line sits lower than its
  // own box's top edge, so markers flush at +2 read as sitting above the text
  // they belong beside. Costs no marker — the column still fits 7 (6 with a
  // foot counter).
  const squaresTop = barHeight + 5;
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

  // The label's wrap width and left edge both make room for the marker column
  // — not just drawn on top of it — so a long line can't run through the
  // squares. But only when there are squares: an empty column is 8px of a
  // 72px key, a seventh of the line, and holding it open for markers that
  // aren't there costs a word on most keys.
  //
  // The price is that the left edge moves when a key's first marker appears,
  // rather than staying put board-wide. That's paid on a key whose body is
  // re-wrapping at that moment anyway — a subagent starting is exactly when
  // its parent's aiTitle changes too.
  const textLeftX = (totalMarkers > 0 ? marginWidth : 0) + 3;
  // Budgeted from where the text actually starts, with the same 3px inset kept
  // on the right. `width - marginWidth` was 3px too generous on each side and
  // got away with it only while lines were cut by a flat, over-wide
  // character estimate; filled to the pixel, that ran the last glyph off the key.
  const textWidth = width - textLeftX - 3;

  // Lowercase body against the header's uppercase caps, so the two rows read
  // as distinct typographic levels rather than fighting for the same weight.
  let lines = wrapLabel(label.toLowerCase(), textWidth, fontSize, BODY_LETTER_SPACING);
  if (lines.length > maxLines) {
    // aiTitle can be a full sentence; anything past what the key can show
    // vertically gets cut, with the last visible line ellipsized.
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(lines[maxLines - 1], textWidth, fontSize, BODY_LETTER_SPACING);
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
            ? `<rect y="${titleHeight - gaugeTrack}" width="${width}" height="${gaugeTrack}" fill="#000000cc" />
               <rect y="${titleHeight - gaugeTrack + 1}" width="${(width * Math.min(100, Math.max(0, context))) / 100}"
                     height="${GAUGE_HEIGHT}" fill="${gaugeColor(context, contextPhase)}" />`
            : `<rect y="${titleHeight - gaugeTrack}" width="${width}" height="${gaugeTrack}" fill="#000000aa" />`
          : ""
      }
      ${
        caps
          ? `<text x="50%" y="${titleTopPad + titleBorder + titleTextRow / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(caps)}</text>`
          : ""
      }
      ${
        // Nothing to say yet: after a /clear, keyFields deliberately blanks the
        // label rather than falling back to the pre-clear title, and a key with
        // an empty body reads as one that failed to draw. Centered in the body,
        // in the detail board's tile-label face. Gated on `project` so the
        // detail board's own two-key title — project:"", and blank on the
        // second key for any short title — stays blank.
        lines.length === 0 && project
          ? `<text x="50%" y="${(bodyTop + height - footHeight) / 2}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" text-anchor="middle"
                   dominant-baseline="middle">CLEAR</text>`
          : `<text font-family="sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="${BODY_LETTER_SPACING}" fill="#ffffff"
            text-anchor="start" dominant-baseline="middle">${tspans}</text>`
      }
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

// Nearly spent: the level where the gauge goes red, gets its extra 2px, and
// starts breathing. One constant so those three can't drift apart.
export const CONTEXT_CRITICAL = 85;

/**
 * Green under half, amber past that, red once a window is nearly spent. Bright
 * enough to read as a few pixels sitting on a light accent colour.
 */
export function usageColor(pct) {
  return pct >= CONTEXT_CRITICAL ? "#ff5252" : pct >= 50 ? "#ffc107" : "#69f0ae";
}

// The other half of the red gauge's flash. A pale pink sat here first, then
// white on a cosine, and neither could be seen on the deck: 2px of line fading
// through the middle of a swing spends most of its time looking like one
// steady colour. The gauge is the smallest animated thing on the board, so it
// gets the crudest signal — two colours, no in-between.
const CONTEXT_FLASH = "#ffffff";

/**
 * The gauge's colour at `phase` (0–1 of one flash). Below the red threshold,
 * and at phase 0 anywhere, this is exactly `usageColor` — so the steady frame
 * every non-pulsing board draws looks as it always did.
 *
 * A square wave, not a fade: the second half of the cycle is white, full stop.
 * The gauge is 2px on a near-black track, and anything gradual on a line that
 * thin is a colour the eye never catches changing. It flashes *brighter*, not
 * dimmer, for the same reason it always did — the dim end would drop below the
 * contrast floor `colors-check` holds it to, which is a gauge that keeps
 * vanishing rather than one that flashes.
 */
export function gaugeColor(pct, phase = 0) {
  const base = usageColor(pct);
  if (pct < CONTEXT_CRITICAL) return base;
  return phase < 0.5 ? base : CONTEXT_FLASH;
}

// One thickness at every level, and one pixel of it hangs below the header's
// dark track onto the key's own background — the track is the row above the
// fill, so the fill's last row has never had one behind it.
// Red used to draw at 4px, because colour alone
// is a weak signal at 72px across a room and height was the channel that read
// peripherally — but motion reads from further away than either, and the
// breath now carries "nearly spent" on its own. Two signals for one fact left
// the red gauge spilling 2px past the header's dark border onto the key's
// background, which is a lot of key for a thing the breath already says.
const GAUGE_HEIGHT = 3;

/**
 * Usage key: the two rate-limit windows Claude Code's /usage reports, stacked.
 * `session` / `week` are percentages, or null while unknown.
 */
// `title`/`active`/`rows` are the stats board's per-account variant: a caps
// title across the top and a border — the busy green for the active
// subscription (the one the bottom-right key also describes), grey otherwise,
// none when `active` is left out (the memory key), and rows that carry either a
// `pct` (a bar) or a `text` (a reset time, no bar). Without them this is the
// usage key exactly as it always was.
export async function renderUsage({ width, height, session, week, title, active, rows }) {
  const titleH = title ? Math.round(height * 0.18) : 0;
  const half = (height - titleH) / 2;
  rows = (rows ?? [
    { caps: "SESSION", pct: session },
    { caps: "WEEK", pct: week },
  ]).map((r, i) => ({ ...r, top: titleH + i * half }));
  const capSize = Math.round(height * 0.11);
  // Off the row, not the key: a titled key's rows are a fifth shorter, and a
  // value sized for the full-height row runs into its own caps.
  const pctSize = Math.round(half * (title ? 0.62 : 0.52));

  const head = title
    ? `<text x="50%" y="${titleH * 0.5}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
             letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff" text-anchor="middle"
             dominant-baseline="middle">${fitCaps(title, width, capSize)}</text>
       ${typeof active === "boolean" ? `<rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="4" fill="none"
             stroke="${active ? BUSY : "#555555"}" stroke-width="3" />` : ""}`
    : "";

  const body = rows
    .map(({ caps, pct, text, top }) => {
      const known = typeof pct === "number";
      const shown = known ? Math.min(100, Math.max(0, Math.round(pct))) : 0;
      const barY = top + half - 7;
      const value = text !== undefined ? text : known ? shown + "%" : "—";
      // A row with a `text` and no `pct` is a reset time — no bar. One with
      // both is an amount said over its own gauge (the memory keys in GB).
      const bar =
        !known
          ? ""
          : `<rect x="6" y="${barY}" width="${width - 12}" height="4" rx="2" fill="#ffffff22" />
        <rect x="6" y="${barY}" width="${((width - 12) * shown) / 100}" height="4" rx="2"
              fill="${usageColor(shown)}" />`;
      // Titled keys have a fifth less height, so caps and value share one
      // line — "SE  12%" — centred on each other, rather than stacking.
      if (title) {
        const y = top + (known ? half * 0.4 : half * 0.5);
        return `
        <text x="6" y="${y}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
              letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" dominant-baseline="middle">${{ SESSION: "SE", WEEK: "WK" }[caps] ?? caps}</text>
        <text x="${width - 6}" y="${y}" font-family="sans-serif" font-size="${pctSize}" fill="#ffffff"
              text-anchor="end" dominant-baseline="middle">${value}</text>
        ${bar}`;
      }
      return `
        <text x="50%" y="${top + half * 0.24}" font-family="sans-serif" font-size="${capSize}"
              font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" text-anchor="middle"
              dominant-baseline="middle">${caps}</text>
        <text x="50%" y="${top + half * (text !== undefined ? 0.68 : 0.6)}" font-family="sans-serif" font-size="${pctSize}"
              fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${value}</text>
        ${bar}`;
    })
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <rect y="${titleH + half - 1}" width="${width}" height="1" fill="#ffffff22" />
      ${head}${body}
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * The attention key: how many sessions want you, and how long the worst one
 * has been waiting. Dark and quiet at zero — an empty queue should read as
 * "nothing to do here", not as a key that failed to draw.
 */
export async function renderAttention({ width, height, count, longest, pulse, label = "WAITING" }) {
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
                   font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffffcc" text-anchor="middle"
                   dominant-baseline="middle">${label}</text>
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
export async function renderStat({ width, height, label, value, big = false, pie }) {
  const capSize = Math.round(height * 0.1);
  const caps = fitCaps(label, width, capSize);

  // `pie` turns the tile into a ring — a percentage is a proportion, and a
  // ring says "most of the way round" in a glance where three characters have
  // to be read. Same colours as the key gauge (`usageColor`), so a red ring
  // here and a red gauge on the session key are the same statement twice.
  // The number stays in the hole, but drops the % sign: the ring is what the
  // sign says, and "100%" doesn't fit across a hole this size.
  if (typeof pie === "number") {
    const pct = Math.min(100, Math.max(0, Math.round(pie)));
    const r = Math.round(height * 0.22);
    const stroke = Math.round(height * 0.12);
    const cx = width / 2;
    const cy = height * 0.62;
    const circumference = 2 * Math.PI * r;
    const filled = (circumference * pct) / 100;

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" fill="#1b1b1b" />
        <text x="50%" y="${height * 0.22}" font-family="sans-serif" font-size="${capSize}"
              font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" text-anchor="middle"
              dominant-baseline="middle">${escapeXml(caps)}</text>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff22" stroke-width="${stroke}" />
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${usageColor(pct)}" stroke-width="${stroke}"
                stroke-dasharray="${filled} ${circumference - filled}"
                transform="rotate(-90 ${cx} ${cy})" />
        <text x="${cx}" y="${cy}" font-family="sans-serif" font-size="${Math.round(height * 0.17)}"
              font-weight="600" fill="#ffffff" text-anchor="middle"
              dominant-baseline="middle">${pct}</text>
      </svg>`;

    return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
  }

  const valueSize = Math.round(height * (big ? 0.24 : 0.19));

  // Words, not characters: every stat value here is short words — "opus-5 high"
  // on the detail board, "Sonnet 5" on the stats board's favourite-model tile —
  // and breaking one across two lines makes a tile that has room for both words
  // read as gibberish.
  let lines = wrapWords(value, width, valueSize);
  if (lines.length > 2) {
    lines = lines.slice(0, 2);
    lines[1] = ellipsize(lines[1], width, valueSize);
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
            font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" text-anchor="middle"
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
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(lines[maxLines - 1], width - 6, fontSize);
  }
  const startY = height * 0.3 + lineHeight / 2;
  const tspans = lines.map((line, i) => `<tspan x="3" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`).join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${bg}" />
      <text x="3" y="${height * 0.13}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="${CAPS_LETTER_SPACING}" fill="${text}" dominant-baseline="middle">${number}</text>
      <text font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="${text}"
            text-anchor="start" dominant-baseline="middle">${tspans}</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/**
 * The free-capacity key: how many sessions are sitting idle and could take
 * work now, with how long the longest-idle one has been waiting.
 *
 * **Deliberately not coloured.** Green already means "working" everywhere else
 * on this deck, so a green key for "not working" would fight the palette; and
 * this is a readout rather than an alarm — nothing here is wrong, and nothing
 * here pulses. Dark with a big white number, like the usage key it sits
 * beside, which is also the most scannable thing a 72px key can be.
 *
 * Mirrors renderAttention's shape exactly, down to the quiet state: CLEAR
 * there means nothing is waiting on you, BUSY here means nothing is free.
 *
 * `label`/`quietWord` default to that pair but are overridable — the status
 * key's busy leg reuses this same shape rather than a near-duplicate function,
 * with WORKING/FREE in their place (FREE there means nothing is busy, the
 * same cross-referential idiom running the other way).
 */
export async function renderFree({ width, height, count, longest, label = "FREE", quietWord = "BUSY" }) {
  const capSize = Math.round(height * 0.11);
  const countSize = Math.round(height * 0.34);
  const quiet = count === 0;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <text x="50%" y="${height * 0.38}" font-family="sans-serif" font-size="${quiet ? capSize : countSize}"
            font-weight="bold" fill="${quiet ? "#ffffff55" : "#ffffff"}" text-anchor="middle"
            dominant-baseline="middle">${quiet ? quietWord : count}</text>
      ${
        quiet
          ? ""
          : `<text x="50%" y="${height * 0.66}" font-family="sans-serif" font-size="${capSize}"
                   font-weight="bold" letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffffcc" text-anchor="middle"
                   dominant-baseline="middle">${label}</text>
             <text x="50%" y="${height * 0.85}" font-family="sans-serif" font-size="${capSize}"
                   fill="#ffffff99" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(longest ?? "")}</text>`
      }
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
                   letter-spacing="${CAPS_LETTER_SPACING}" fill="#000000bb" text-anchor="middle"
                   dominant-baseline="middle">${escapeXml(fitCaps(project, width, capSize))}</text>`
          : ""
      }
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff33" stroke-width="${stroke}" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${arc} ${circumference - arc}"
              stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})" />
      <text x="50%" y="${height * 0.84}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffffdd" text-anchor="middle"
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
// One dark tile with a glyph over a caps label — the back key on the detail
// and stats boards, and the stats board's config key. The defaults are what
// this drew when it only ever drew the back key. `glyph` and `caps` are this
// project's own literals, never anything read off disk, so they go into the
// SVG as-is.
export async function renderBack({ width, height, glyph = "←", caps = "BACK" }) {
  const capSize = Math.round(height * 0.11);
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1b1b1b" />
      <text x="50%" y="${height * 0.44}" font-family="sans-serif" font-size="${Math.round(height * 0.42)}"
            fill="#ffffffdd" text-anchor="middle" dominant-baseline="middle">${glyph}</text>
      <text x="50%" y="${height * 0.78}" font-family="sans-serif" font-size="${capSize}" font-weight="bold"
            letter-spacing="${CAPS_LETTER_SPACING}" fill="#ffffff99" text-anchor="middle" dominant-baseline="middle">${caps}</text>
    </svg>`;

  return sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer();
}

/** Blank/off key, used to clear unassigned slots. */
/**
 * The home-screen icon. Neither platform lets a page install itself — iOS has
 * no API at all and Android can only offer a button — so the most this can do
 * is make what you *do* save look like an app instead of a Safari bookmark.
 *
 * Nine keys on a dark ground, in this project's own accents with the two state
 * colours a glance is actually looking for. Drawn here rather than shipped as
 * a file for the reason every other image here is: sharp is already a
 * dependency, the palette is already imported, and a checked-in PNG is a
 * second copy of the colours to keep in step.
 */
export async function renderIcon(size = 512) {
  const pad = size * 0.14;
  const gap = size * 0.035;
  const cell = (size - 2 * pad - 2 * gap) / 3;
  // Enough to read as "a board with things happening on it" at 60px, which is
  // the size this is actually seen at.
  const fills = [
    ACCENT_ICON[0], BUSY, ACCENT_ICON[1],
    BUSY, ACCENT_ICON[2], STATE_COLORS.waiting,
    ACCENT_ICON[3], STATE_COLORS.idle, BUSY,
  ];
  const keys = fills
    .map((fill, i) => {
      const x = pad + (i % 3) * (cell + gap);
      const y = pad + Math.floor(i / 3) * (cell + gap);
      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${cell * 0.16}" fill="${fill}" />`;
    })
    .join("");
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="#0b0b0b" />
      ${keys}
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Four of the accents, named here rather than imported: accents.mjs imports
// nothing from this file and this file imports nothing from it, and one icon
// is not a reason to make that edge exist.
const ACCENT_ICON = ["#4fc3f7", "#ffb74d", "#f06292", "#81c784"];

export async function renderBlank({ width, height }) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .raw()
    .toBuffer();
}
