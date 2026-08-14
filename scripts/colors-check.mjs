// The palette is data, but it has to satisfy numbers, and the numbers are
// what silently rot: someone nudges a hex to taste and a marker or a line of
// body text quietly stops being visible on one key out of fifteen — which you
// only find out by looking at that key, in that state, on the actual deck.
//
// Three tiers, separated by lightness: STATE_COLORS fill a whole key and stay
// dark, ACCENTS are the light identity bar, MARKER_COLORS and the usage gauge
// are a handful of bright pixels drawn on top. Every floor below was measured
// from the palette as it stands, then rounded down — they're the current
// design's own guarantees, not aspirations.

import { STATE_COLORS, MARKER_COLORS, usageColor, gaugeColor, CONTEXT_CRITICAL } from "../src/render.mjs";
import { ACCENTS } from "../src/index.mjs";

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (h) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio, 1–21. What decides whether small marks read at all. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*a*b*. L* is the lightness the tiers are stratified by. */
function lab(h) {
  const [r, g, b] = hex(h).map(lin);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** Plain CIE76 distance — coarse, but the thresholds here are coarse too. */
function deltaE(a, b) {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Alpha-composites a fill over a background, for the `#ffffffaa` cases. */
const over = (fg, alpha, bg) => {
  const f = hex(fg);
  const b = hex(bg);
  return "#" + f.map((c, i) => Math.round((c * alpha + b[i] * (1 - alpha)) * 255).toString(16).padStart(2, "0")).join("");
};

let failed = false;
function check(what, actual, floor) {
  if (actual < floor) {
    console.error(`FAILED: ${what} — ${actual.toFixed(2)}, floor ${floor}`);
    failed = true;
  }
}

// renderKey draws body text as flat #ffffff on every state background, with no
// per-state branch, so the darkest-passing state sets the floor for all four.
// 4.5 is WCAG AA for body text; the old bright amber sat at 2.12 here.
for (const [state, bg] of Object.entries(STATE_COLORS)) {
  check(`white body text on ${state}`, contrast("#ffffff", bg), 4.5);
}

// The margin squares are 3×6px. 2.9 is what the dimmest surviving pair
// (shell blue on the busy green key) actually measures; below that they stop
// registering as anything at a glance. `shell` shares BUSY as a background,
// so the four distinct backgrounds are what every marker has to clear.
//
// requires_action is the documented exception at 2.7: red is the darkest hue
// going, and anything light enough to clear 2.9 stops reading as red and
// starts converging on the white idle marker. Its floor is the ceiling of what
// that hue can do, not a target — see the comment on MARKER_COLORS.
const backgrounds = [...new Set(Object.values(STATE_COLORS))];
for (const [state, marker] of Object.entries(MARKER_COLORS)) {
  for (const bg of backgrounds) {
    check(`${state} marker on ${bg}`, contrast(marker, bg), state === "requires_action" ? 2.7 : 2.9);
  }
}

// Markers are also only told apart from each other. Same 30 ΔE bar as the
// accents — both are asking "are these two small marks the same colour?".
// Closest pairs: shell blue vs the white idle square (36), then the pale red
// vs that same white (43), which is what bounds how light the red may go.
const markers = Object.entries(MARKER_COLORS);
for (let i = 0; i < markers.length; i++) {
  for (let j = i + 1; j < markers.length; j++) {
    check(`${markers[i][0]} vs ${markers[j][0]} marker`, deltaE(markers[i][1], markers[j][1]), 30);
  }
}

// Four states have to be told apart across a desk. 50 ΔE is comfortably above
// any just-noticeable threshold and is what the current set holds.
const states = Object.entries(STATE_COLORS).filter(([, v], i, all) => all.findIndex(([, w]) => w === v) === i);
for (let i = 0; i < states.length; i++) {
  for (let j = i + 1; j < states.length; j++) {
    check(`${states[i][0]} vs ${states[j][0]}`, deltaE(states[i][1], states[j][1]), 50);
  }
}

// Accents carry dark caps text (#000000bb) and must not be confusable with
// each other. 30 ΔE is the floor the set sits at (yellow/lime, 31).
ACCENTS.forEach((accent, i) => {
  check(`caps on accent ${i}`, contrast(over("#000000", 0.733, accent), accent), 4.0);
  ACCENTS.slice(i + 1).forEach((other, j) => {
    check(`accent ${i} vs ${i + 1 + j}`, deltaE(accent, other), 30);
  });
  // The bar sits directly on the key's state colour; if they converge the bar
  // stops saying which project this is. Brown-300 against the idle grey was
  // 25 here, the worst pair in the scheme, which is why it's a warm grey now.
  for (const [state, bg] of Object.entries(STATE_COLORS)) {
    check(`accent ${i} vs ${state} key`, deltaE(accent, bg), 30);
  }
});

// The context gauge draws inside the accent bar's lower border. It is NOT
// checked against the accent — at 1.0–1.7:1 for most pairs it would never
// pass, which is exactly why renderKey insets it 1px onto the #000000cc
// track instead of letting it butt onto the accent. So: check it against the
// track it actually sits on.
const track = over("#000000", 0.8, "#ffffff"); // #000000cc over any accent ≈ this or darker
for (const pct of [0, 49, 50, 84, 85, 100]) {
  check(`gauge at ${pct}% on its track`, contrast(usageColor(pct), track), 3.0);
}

// Past CONTEXT_CRITICAL the gauge breathes, so every frame of that breath has
// to clear the same floor — a breath that fades out of legibility is a gauge
// that keeps disappearing. It brightens rather than dims for exactly that
// reason, which the first check below is what proves.
for (const phase of [0, 0.25, 0.5, 0.75]) {
  check(`red gauge mid-breath (phase ${phase})`, contrast(gaugeColor(100, phase), track), 3.0);
}
// And it has to be a breath: the same colour below the threshold, a swing wide
// enough to see above it. 20 is roughly "obvious side by side" in CIE76.
if (gaugeColor(CONTEXT_CRITICAL - 1, 0.5) !== usageColor(CONTEXT_CRITICAL - 1)) {
  console.error("FAILED: an amber gauge must not pulse");
  failed = true;
}
check("the red gauge's breath is wide enough to see", deltaE(gaugeColor(100, 0), gaugeColor(100, 0.5)), 20);
if (gaugeColor(100, 0) !== usageColor(100)) {
  console.error("FAILED: a steady frame must be the plain red every other board draws");
  failed = true;
}

// Green and amber are literally the marker colours, so the board speaks one
// vocabulary at two brightnesses; if someone retunes one, this catches the
// drift. Red is deliberately NOT shared: the marker had to go pale to survive
// a mid-dark key, while the gauge sits on a near-black track where the
// saturated alarm red both reads and alarms. Same meaning, different substrate.
for (const [pct, state] of [[10, "busy"], [60, "waiting"]]) {
  if (usageColor(pct) !== MARKER_COLORS[state]) {
    console.error(`FAILED: usageColor(${pct}) is ${usageColor(pct)}, expected MARKER_COLORS.${state} ${MARKER_COLORS[state]}`);
    failed = true;
  }
}

// Tier stratification: every marker and accent is lighter than every state
// background. This is the rule the whole scheme rests on — small bright marks
// on large dark fields — and the one the old amber broke.
const darkest = Math.min(...[...ACCENTS, ...Object.values(MARKER_COLORS)].map((c) => lab(c)[0]));
const lightest = Math.max(...backgrounds.map((c) => lab(c)[0]));
if (!(darkest > lightest)) {
  console.error(`FAILED: lightest state L* ${lightest.toFixed(0)} is not below darkest accent/marker L* ${darkest.toFixed(0)}`);
  failed = true;
}

if (failed) process.exit(1);
console.log("OK: state text contrast, marker contrast, state separation");
console.log("OK: accent caps, accent separation, accent vs state");
console.log("OK: gauge on track, gauge/marker vocabulary, tier stratification");
