// Verifies the config server's trust boundary and its one mutation: the token
// gate, the closed-set validation on both fields, HTML escaping of folder keys
// (which for a remote project are another machine's strings), and that a valid
// POST calls setAccent exactly once with what was asked for.
// Run: node scripts/config-check.mjs
import { createConfigServer } from "../src/config-server.mjs";
import { ACCENTS } from "../src/accents.mjs";

const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};

const ALPHA = "/projects/alpha";
const REMOTE = "pi:/home/pi/x";
// A legal directory name that is also an HTML injection in both element and
// attribute context — the quote matters, since the folder key is written into
// a hidden input's value.
const NASTY = '/projects/<script>"x';

let calls = [];
const projects = () => [
  { key: ALPHA, name: "alpha", host: null, accent: ACCENTS[0] },
  { key: REMOTE, name: "x", host: "pi", accent: ACCENTS[1] },
  { key: NASTY, name: '<script>"x', host: null, accent: ACCENTS[2] },
];
const { server, url } = await createConfigServer({
  projects,
  setAccent: (...args) => calls.push(args),
});
const base = new URL(url).origin;
const token = new URL(url).searchParams.get("t");

// The token gate comes before routing, so an unknown path without a token
// answers 403 rather than confirming the path is unknown.
eq((await fetch(`${base}/`)).status, 403, "no token is refused");
eq((await fetch(`${base}/?t=wrong`)).status, 403, "a wrong token is refused");
eq((await fetch(`${base}/nope?t=${token}`)).status, 404, "an unknown path with a good token is a 404");
eq((await fetch(`${base}/nope`)).status, 403, "an unknown path without one is still 403");

const page = await fetch(url);
eq(page.status, 200, "the page is served");
const html = await page.text();
eq(html.includes("alpha"), true, "the page lists a local project");
eq(html.includes("pi:/home/pi/x"), true, "and a remote one by its full key");
// Eight swatches per project, three projects.
eq(html.split('name="accent"').length - 1, 24, "eight swatches per project");
eq(page.headers.get("referrer-policy"), "no-referrer", "the token cannot travel in a Referer");

// Escaping: neither an element nor an attribute break-out survives. The quote
// case is the one that matters — a tag-only escaper passes both <script>
// assertions below while leaving the hidden field injectable.
// Exactly one — the drag script the page ships. A second is a folder name that
// reached the document as a tag. Counting beats "contains" now that the page
// legitimately has one of its own.
eq(html.split("<script>").length - 1, 1, "a folder named <script> does not reach the page as a second tag");
eq(html.includes("&lt;script&gt;"), true, "it is escaped instead");
eq(html.includes('value="/projects/<script>"x"'), false, "and the quote does not break out of the hidden field");
eq(html.includes("&quot;"), true, "the quote is escaped too");

const post = (body, t = token) =>
  fetch(`${base}/accent?t=${t}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

calls = [];
eq((await post(`folder=${encodeURIComponent(ALPHA)}&accent=%23123456`)).status, 400, "a colour outside the palette is refused");
eq(calls.length, 0, "and nothing was mutated");

eq(
  (await post(`folder=${encodeURIComponent(ALPHA)}&accent=${encodeURIComponent(ACCENTS[1])}`, "wrong")).status,
  403,
  "a POST with a bad token is refused"
);
eq(calls.length, 0, "and nothing was mutated");

eq(
  (await post(`folder=%2Fprojects%2Fgone&accent=${encodeURIComponent(ACCENTS[1])}`)).status,
  400,
  "a folder that is not live is refused"
);
eq(calls.length, 0, "and nothing was mutated");

eq(
  (await post(`folder=${encodeURIComponent(ALPHA)}&accent=${encodeURIComponent("x".repeat(5000))}`)).status,
  400,
  "an oversized body is refused"
);
eq(calls.length, 0, "and nothing was mutated");

const ok = await post(`folder=${encodeURIComponent(ALPHA)}&accent=${encodeURIComponent(ACCENTS[3])}`);
eq(ok.status, 303, "a valid POST redirects back to the page");
eq(ok.headers.get("location"), `/?t=${token}`, "carrying the token, or the redirect would 403");
eq(calls, [[ALPHA, ACCENTS[3]]], "and setAccent was called once with what was asked for");

// Reordering. Every row carries the key the drag script reads back, and a
// handle that is the only draggable thing on it — dragging from anywhere on
// the row would fight the swatch buttons.
eq(html.split('class="handle" draggable="true"').length - 1, 3, "every row has one drag handle");
eq(html.includes(`data-key="${ALPHA}"`), true, "and the key the drop reads back off the DOM");
eq(html.includes("draggable=\"true\"></div>"), false, "nothing else on the row is draggable");

let moves = [];
const withOrder = await createConfigServer({ projects, setAccent: () => {}, reorder: (...a) => moves.push(a) });
const orderBase = new URL(withOrder.url).origin;
const orderToken = new URL(withOrder.url).searchParams.get("t");
const post2 = (body) =>
  fetch(`${orderBase}/order?t=${orderToken}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

// The page order is ALPHA, REMOTE, NASTY. A request says what the pointer was
// over and which half of it; turning that into an anchor is the server's job,
// which is what these cases exist to pin. It lived in the browser until a drop
// below the last row put a project second-to-last instead of last, where
// nothing could see it.
const drop = (folder, target, side) =>
  post2(`folder=${encodeURIComponent(folder)}&target=${encodeURIComponent(target)}&side=${side}`);

eq((await drop("/projects/gone", ALPHA, "above")).status, 400, "reordering an unlisted project is refused");
eq(moves.length, 0, "and nothing moved");
eq((await drop(ALPHA, "/projects/gone", "above")).status, 400, "a stale anchor is refused rather than meaning last");
eq(moves.length, 0, "and nothing moved");
eq((await drop(ALPHA, REMOTE, "sideways")).status, 400, "a side that isn't above or below is refused");
eq(moves.length, 0, "and nothing moved");

moves = [];
const moved = await drop(ALPHA, REMOTE, "above");
eq(moved.status, 303, "a valid move redirects back to the page");
eq(moves, [[ALPHA, REMOTE]], "dropping above a row anchors on that row");

// The regression this file was extended for. Dropping below the LAST row is
// the only case whose anchor is null, and it is the one the client used to get
// wrong — every other side/target pair produces a real key, so "below" being
// silently read as "above" stayed invisible everywhere else.
moves = [];
await drop(ALPHA, NASTY, "below");
eq(moves, [[ALPHA, null]], "dropping below the last row means last");

// Below a middle row is the row after it — and the dragged project is removed
// before the index is taken, or everything past it shifts by one.
moves = [];
await drop(ALPHA, REMOTE, "below");
eq(moves, [[ALPHA, NASTY]], "dropping below a middle row anchors on the next one");
moves = [];
await drop(NASTY, ALPHA, "below");
eq(moves, [[NASTY, REMOTE]], "the dragged project is not its own successor");

// Dropping a row on itself is a no-op, not an error: the client already
// refuses to mark the dragged row, but the arithmetic must not depend on that.
moves = [];
eq((await drop(ALPHA, ALPHA, "below")).status, 303, "dropping a row on itself is accepted");
eq(moves.length, 0, "and moves nothing");
withOrder.server.close();

// The activity page. Every number arrives already formatted and every bar as a
// percentage — index.mjs owns the summarising, the clock and the units, this
// file owns the markup — so the check renders the page from fixed fixtures
// rather than reconstructing a day of transitions and a gigabyte of
// transcripts.
const historyRows = [
  { key: ALPHA, name: "alpha", accent: "#4fc3f7", busy: "3h12m", waiting: "41m", blocked: "18m", total: "4h11m", pct: 80 },
  // An accent reaches a CSS colour slot rather than text, so a hostile one is
  // a fixture rather than a hypothetical: readAccents only checks that the
  // stored value is a string.
  { key: NASTY, name: '<script>"x', accent: "red;background:url(evil)", busy: "—", waiting: "—", blocked: "—", total: "51m", pct: 20 },
];
const PERIODS = [{ key: "24h", name: "24 hours" }, { key: "7d", name: "7 days" }, { key: "all", name: "all time" }];
const activity = {
  period: "24h",
  periods: PERIODS,
  rows: historyRows,
  pie: {
    // Cumulative stops, not shares: index.mjs owns that running total.
    slices: [{ accent: "#4fc3f7", from: 0, to: 80 }, { accent: "red;background:url(evil)", from: 80, to: 100 }],
    total: "5h02m",
    label: "24 hours",
  },
  // The two time series are columns — time on the x axis — and the by-model
  // list stays a row per name, because those are categories rather than a
  // clock.
  tokens: {
    peak: "900k",
    // Two meters ran in this window, so the columns stack and the chart earns
    // a legend. A machine that never runs the ship review reports one provider
    // and gets neither.
    providers: ["claude", "codex"],
    // Money is its own line rather than another number in the heading: every
    // rung but the metered one is zero by construction.
    cost: "$5.75 billed to the metered API · 17 reviews",
    cols: [
      { label: "09:00", tick: "9h", bars: [{ state: "claude", pct: 70 }, { state: "codex", pct: 30 }], value: "claude 630k · codex 270k" },
      { label: "10:00", tick: "", bars: [{ state: "claude", pct: 40 }], value: "claude 360k" },
    ],
  },
  models: [{ label: "opus-5", bars: [{ state: "tokens", pct: 100 }], value: "1.1M" }],
  sessions: {
    peak: "3",
    cols: [
      { label: "09:00", tick: "9h", unseen: false, bars: [{ state: "busy", pct: 50 }, { state: "idle", pct: 25 }], value: "3 open" },
      // The hour nobody watched: no bars, striped column. This is the one the
      // whole TICK mechanism exists to make possible, and it must not render
      // as an idle hour.
      { label: "10:00", tick: "", unseen: true, bars: [], value: "not watched" },
    ],
  },
};
let askedFor = null;
const withHistory = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  // The page hands the window straight through and renders whatever comes
  // back — index.mjs owns which windows exist and which one an unknown string
  // falls back to, so an edited URL cannot produce a picker that disagrees
  // with the charts below it.
  activity: (p) => {
    askedFor = p;
    return { ...activity, period: p === "7d" ? "7d" : "24h" };
  },
});
const hBase = new URL(withHistory.url).origin;
const hToken = new URL(withHistory.url).searchParams.get("t");

eq((await fetch(`${hBase}/activity`)).status, 403, "the activity page is behind the same token");
const hPage = await fetch(`${hBase}/activity?t=${hToken}`);
eq(hPage.status, 200, "and is served with it");
const hHtml = await hPage.text();
eq(hHtml.includes("3h12m"), true, "the numbers reach the table");
eq(hHtml.includes("4h11m"), true, "including the total the pie is a share of");
// One table now, following the same window picker as the charts above it.
eq(hHtml.split('class="project"').length - 1, 2, "one row per project, in one table");
eq(hHtml.includes("5h02m of session time"), true, "the pie says what it is a share of");
eq(hHtml.includes("conic-gradient(#4fc3f7 0% 80%,"), true, "slices render as cumulative gradient stops");
// The dot ties a row to its slice, so the pie needs no legend.
eq(hHtml.split('class="dot"').length - 1, 2, "every row carries its slice's colour");
// esc() makes a string safe as text, and a colour slot is not text. This is
// the same boundary `pct` crosses, and it needs the same coercion.
eq(hHtml.includes("evil"), false, "an accent that is not a plain hex never reaches a background");
// Scoped to the table-and-pie block: the idle state is drawn in the same
// neutral up in the sessions chart and its legend.
const split = hHtml.split('class="split"')[1];
eq(split.split("#555555").length - 1, 2, "it becomes the neutral, in the row and in the slice");
// A project name is untrusted here for exactly the reason it is on the other
// page, and this table is a second place it reaches the document.
eq(hHtml.split("<script>").length - 1, 0, "a folder named <script> does not reach the activity page as a tag");
eq(hHtml.includes("&lt;script&gt;"), true, "it is escaped there too");
// The blocked column is coloured to draw the eye to real blocked time, so a
// row with none must not wear it: alpha has a value, the second row an em
// dash.
eq(hHtml.split('class="blocked"').length - 1, 1, "an em dash in the blocked column is not coloured");

// The charts. Widths are the only thing the browser is asked to do, so the
// percentage has to survive into the attribute — a bar that renders at 0%
// is a chart that silently draws nothing.
eq(hHtml.includes("height:70%"), true, "the tallest column fills the plot");
eq(hHtml.includes("height:40%"), true, "and a shorter one is scaled against it");
eq(hHtml.includes("width:100%"), true, "while the by-model list is still a row per name");
// Two token columns, one model bar, two session segments, four legend swatches.
// Three token segments, one model bar, two session segments, two token-legend
// swatches, four state-legend swatches.
eq(hHtml.split("<i style=").length - 1, 12, "one element per bar segment, plus the legend swatches");
eq(hHtml.split('class="col unseen"').length - 1, 1, "an unwatched hour is striped rather than empty");
// Only some hours carry a label, and every column keeps a slot so the ones
// that do stay under their own column.
eq(hHtml.split('<div class="xaxis">')[1].split("</div>")[0].split("<span>").length - 1, 2, "one x-axis slot per column");
eq(hHtml.includes(">9h<"), true, "a labelled hour prints its label");
// The value has nowhere to go under a column, so it rides in a title —
// a tooltip needs no script.
eq(hHtml.includes('title="09:00 · claude 630k · codex 270k"'), true, "a column names itself on hover");
eq(hHtml.includes("peak 900k"), true, "and the scale is stated, since no column can carry it");
// Two vendors on one chart: stacked segments in the vendor's own colour, and a
// legend only because more than one of them ran.
eq(hHtml.includes("background:#4fc3f7"), true, "claude keeps the page's blue");
eq(hHtml.includes("background:#66bb6a"), true, "codex gets its own");
eq(hHtml.includes("$5.75 billed to the metered API · 17 reviews"), true, "and the metered rung's cost is stated as money, not tokens");
const free = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  activity: () => ({ ...activity, tokens: { ...activity.tokens, cost: null } }),
});
const nocost = await (await fetch(free.url.replace("/?", "/activity?"))).text();
eq(nocost.includes('class="cost"'), false, "a window with no API review says nothing rather than $0.00");
free.server.close();
const oneVendor = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  activity: () => ({ ...activity, tokens: { ...activity.tokens, providers: ["claude"] } }),
});
const solo = await (await fetch(oneVendor.url.replace("/?", "/activity?"))).text();
eq(solo.split('class="legend"').length - 1, 1, "one vendor earns no legend of its own — only the states chart keeps hers");
oneVendor.server.close();

// The window picker. Links rather than a select, because a select needs a
// script and this page decides everything on the server.
eq(askedFor, null, "no window in the URL asks index.mjs for nothing in particular");
eq(hHtml.split('class="periods"').length - 1, 1, "the picker renders once");
eq(hHtml.includes('href="/activity?t=' + hToken + '&amp;p=7d"'), true, "each window is a link carrying the token");
// Scoped to the picker: the tab nav above marks its own current entry the
// same way, so counting across the whole document counts both.
const picker = (html) => html.split('class="periods"')[1].split("</div>")[0];
eq(picker(hHtml).split('<a class="on"').length - 1, 1, "exactly one window is marked current");
const weekPage = await (await fetch(`${hBase}/activity?t=${hToken}&p=7d`)).text();
eq(askedFor, "7d", "the window in the URL reaches index.mjs verbatim");
eq(weekPage.includes('<a class="on" href="/activity?t=' + hToken + '&amp;p=7d"'), true, "and the picker marks it");
// An edited URL must not render a picker that disagrees with the charts: the
// page marks whichever window index.mjs says it actually used, never the one
// that was asked for.
const junkPage = await (await fetch(`${hBase}/activity?t=${hToken}&p=../../etc`)).text();
eq(askedFor, "../../etc", "an unknown window is passed through rather than guessed at here");
eq(picker(junkPage).split('<a class="on"').length - 1, 1, "and the page still marks exactly one");
eq(junkPage.includes("etc"), false, "an unknown window never reaches the document");
// pct arrives from index.mjs, but it reaches a style attribute — the one place
// on this page where a number rather than a string does — so it is coerced
// rather than trusted, the same rule the folder field lives by.
const hostile = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  activity: () => ({ ...activity, tokens: [{ label: "x", bars: [{ state: "tokens", pct: "50;background:url(evil)" }], value: "x" }] }),
});
const hostileHtml = await (await fetch(hostile.url.replace("/?", "/activity?"))).text();
eq(hostileHtml.includes("evil"), false, "a non-numeric width never reaches the style attribute");
hostile.server.close();

const emptyHistory = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  activity: () => ({ period: "24h", periods: PERIODS, rows: [], tokens: { peak: "—", cols: [] }, models: [], sessions: { peak: "—", cols: [] } }),
});
eq(
  (await (await fetch(new URL(emptyHistory.url).origin + "/activity?t=" + new URL(emptyHistory.url).searchParams.get("t"))).text()).includes("no history recorded yet"),
  true,
  "no history says so rather than rendering an empty table"
);
emptyHistory.server.close();
withHistory.server.close();

// An empty board says so rather than rendering an empty page.
const { server: empty, url: emptyUrl } = await createConfigServer({ projects: () => [], setAccent: () => {} });
eq((await (await fetch(emptyUrl)).text()).includes("nothing on the board"), true, "an empty board says so");
empty.close();

server.close();
console.log("OK: token gate, palette and folder validation, escaping, swatch count, redirect, reorder, activity page and charts");
