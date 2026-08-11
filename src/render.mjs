import sharp from "sharp";

const STATE_COLORS = {
  working: "#2e7d32", // green
  needs_input: "#e6a700", // amber
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
export async function renderKey({ width, height, state, label }) {
  const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const fontSize = Math.round(height * 0.21);
  const lineHeight = fontSize * 1.15;
  const maxLines = 4;

  let lines = wrapLabel(label, width, fontSize);
  if (lines.length > maxLines) {
    // aiTitle can be a full sentence; anything past what the key can show
    // vertically gets cut, with the last visible line ellipsized.
    const maxChars = Math.max(3, Math.floor(width / (fontSize * 0.58)));
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)) + "…";
  }

  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="50%" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      <text font-family="sans-serif" font-size="${fontSize}" fill="#ffffff"
            text-anchor="middle" dominant-baseline="middle">${tspans}</text>
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
