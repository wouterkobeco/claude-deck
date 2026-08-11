import sharp from "sharp";

// Keyed by the session registry's own status vocabulary.
const STATE_COLORS = {
  busy: "#2e7d32", // green — actively working
  requires_action: "#c62828", // red — blocked on you
  waiting: "#e6a700", // amber — waiting on input
  shell: "#1565c0", // blue — dropped to a shell
  idle: "#555555", // gray
};

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/** Greedily wraps on spaces/hyphens (keeping the hyphen with the prior chunk); hard-breaks anything still too long. */
function wrapLabel(label, width, fontSize) {
  const maxChars = Math.max(3, Math.floor(width / (fontSize * 0.58)));
  const words = label.split(/(?<=[\s-])/);

  const lines = [];
  let current = "";
  for (const w of words) {
    if (current && (current + w).trim().length > maxChars) {
      lines.push(current.trim());
      current = w;
    } else {
      current += w;
    }
  }
  if (current.trim()) lines.push(current.trim());

  return lines.flatMap((line) => {
    if (line.length <= maxChars) return [line];
    const chunks = [];
    for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
    return chunks;
  });
}

/** Renders a solid-color key with a centered, word-wrapped label. Returns a raw RGBA buffer. */
export async function renderKey({ width, height, state, label, accent, progress }) {
  const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const barHeight = accent ? Math.round(height * 0.12) : 0;
  const fontSize = Math.round(height * 0.21);
  // Tighter than typographic ideal so four lines still fit under the bar.
  const lineHeight = fontSize * 1.05;
  const progressSize = Math.round(height * 0.19);
  // The count needs a line of its own, so the title gives one up for it.
  const footHeight = progress ? progressSize * 1.15 : 0;
  const maxLines = progress ? 3 : 4;

  let lines = wrapLabel(label, width, fontSize);
  if (lines.length > maxLines) {
    // aiTitle can be a full sentence; anything past what the key can show
    // vertically gets cut, with the last visible line ellipsized.
    const maxChars = Math.max(3, Math.floor(width / (fontSize * 0.58)));
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)) + "…";
  }

  // Centre the title in what's left between the accent bar and the count.
  const bodyTop = barHeight;
  const bodyHeight = height - barHeight - footHeight;
  const startY = bodyTop + bodyHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="50%" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const done = progress ? Math.round((progress.done / Math.max(1, progress.total)) * width) : 0;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      ${accent ? `<rect width="${width}" height="${barHeight}" fill="${accent}" />` : ""}
      <text font-family="sans-serif" font-size="${fontSize}" fill="#ffffff"
            text-anchor="middle" dominant-baseline="middle">${tspans}</text>
      ${
        progress
          ? `<rect y="${height - 3}" width="${width}" height="3" fill="#00000055" />
             <rect y="${height - 3}" width="${done}" height="3" fill="#ffffffcc" />
             <text x="50%" y="${height - footHeight / 2 - 2}" font-family="sans-serif"
                   font-size="${progressSize}" fill="#ffffffdd" text-anchor="middle"
                   dominant-baseline="middle">${progress.done}/${progress.total}</text>`
          : ""
      }
    </svg>`;

  return sharp(Buffer.from(svg))
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** Blank/off key, used to clear unassigned slots. */
export async function renderBlank({ width, height }) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .raw()
    .toBuffer();
}
