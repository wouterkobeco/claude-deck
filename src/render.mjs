import sharp from "sharp";

const STATE_COLORS = {
  working: "#2e7d32", // green
  needs_input: "#e6a700", // amber
  idle: "#555555", // gray
};

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

/** Renders a solid-color key with a centered label. Returns a raw RGBA buffer. */
export async function renderKey({ width, height, state, label }) {
  const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const fontSize = Math.round(height * 0.16);
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${color}" />
      <text x="50%" y="50%" font-family="sans-serif" font-size="${fontSize}"
            fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>
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
