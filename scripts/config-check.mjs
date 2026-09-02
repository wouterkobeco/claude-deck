// Verifies the config server's trust boundary and its one mutation: the token
// gate, the closed-set validation on both fields, HTML escaping of folder keys
// (which for a remote project are another machine's strings), and that a valid
// POST calls setAccent exactly once with what was asked for.
// Run: node scripts/config-check.mjs
import { createConfigServer, lanAddress } from "../src/config-server.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, readBoardState, writeBoardState } from "../src/board-state.mjs";
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
  // Only ALPHA carries a rename, so the reset icon's presence/absence is
  // covered by the same three-project fixture the rest of the page uses.
  { key: ALPHA, name: "alpha", host: null, accent: ACCENTS[0], renamed: true },
  { key: REMOTE, name: "x", host: "pi", accent: ACCENTS[1] },
  { key: NASTY, name: '<script>"x', host: null, accent: ACCENTS[2] },
];
let nameCalls = [];
const { server, url } = await createConfigServer({
  projects,
  setAccent: (...args) => calls.push(args),
  setName: (...args) => nameCalls.push(args),
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
eq(html.includes('class="pname">alpha<'), true, "the name sits in its own hoverable span");
eq(html.includes('class="pname-reset"'), true, "a renamed project gets the reset icon");
eq(html.split('class="pname-reset"').length - 1, 1, "and only the one that's actually been renamed");
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
eq(html.split("<script>").length - 1, 2, "a folder named <script> does not reach the page as a third tag, beside the header's own and the page's");
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

// Renaming. Same shape as /accent: the token gate, the live-project guard,
// and setName called with the trimmed value.
const rename = (body, t = token) =>
  fetch(`${base}/rename?t=${t}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
nameCalls = [];
eq(
  (await rename(`folder=${encodeURIComponent(ALPHA)}&name=${encodeURIComponent("  Renamed  ")}`, "wrong")).status,
  403,
  "a rename with a bad token is refused"
);
eq(nameCalls.length, 0, "and nothing was mutated");
eq((await rename(`folder=%2Fprojects%2Fgone&name=x`)).status, 400, "a folder that is not live is refused");
eq(nameCalls.length, 0, "and nothing was mutated");
const renamed = await rename(`folder=${encodeURIComponent(ALPHA)}&name=${encodeURIComponent("  Renamed  ")}`);
eq(renamed.status, 303, "a valid rename redirects back to the page");
eq(renamed.headers.get("location"), `/?t=${token}`, "carrying the token");
eq(nameCalls, [[ALPHA, "  Renamed  "]], "setName gets the raw value — trimming is applyRename's job, not the route's");
// An empty name is a valid POST too — it's how a rename is cleared back to
// the derived one, not a malformed request.
nameCalls = [];
eq((await rename(`folder=${encodeURIComponent(ALPHA)}&name=`)).status, 303, "an empty name clears the override rather than erroring");
eq(nameCalls, [[ALPHA, ""]]);

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
  // Input has its own chart — it runs orders of magnitude above output — and
  // stacks by kind.
  input: {
    peak: "40M",
    cols: [
      { label: "09:00", tick: "9h", bars: [{ state: "input", pct: 5 }, { state: "cache-read", pct: 90 }, { state: "cache-write", pct: 5 }], value: "input 2M · cache-read 36M · cache-write 2M" },
      { label: "10:00", tick: "", bars: [], value: "—" },
    ],
  },
  // One pair of memory charts per machine, this one first; a second machine
  // is what earns the names in the headings.
  memory: [
    {
      name: "This Mac",
      claude: { peak: "max 5.4 GB", cols: [
        { label: "09:00", tick: "9h", unseen: false, bars: [{ state: "claude", pct: 100 }], value: "5.4 GB · 17 sessions" },
        { label: "10:00", tick: "", unseen: true, bars: [], value: "not watched" },
      ] },
      pressure: { peak: "max 75%", cols: [
        { label: "09:00", tick: "9h", unseen: false, bars: [{ state: "memory-high", pct: 75 }], value: "pressure 75% · swap 90%" },
        { label: "10:00", tick: "", unseen: true, bars: [], value: "not watched" },
      ] },
    },
    {
      name: "pi",
      claude: { peak: "max 1 MB", cols: [{ label: "09:00", tick: "9h", unseen: false, bars: [], value: "0 MB · 0 sessions" }] },
      pressure: { peak: "max 40%", cols: [{ label: "09:00", tick: "9h", unseen: false, bars: [{ state: "memory", pct: 40 }], value: "pressure 40% · swap 0%" }] },
    },
  ],
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
  // The activity page absorbed the rate-limit block, so every server that
  // renders it needs both formatters.
  status: async () => ({
    usage: { session: 82, week: 26, sessionResets: "2h", weekResets: "7d" },
    stats: [{ label: "Sessions", value: "4.4k" }],
    blocked: "41m",
    version: "9.9.9",
    account: "Wouter",
    memory: [{ name: "This Mac", pressure: 41, swap: 93.2, totalMb: 65536, swapTotalMb: 20480 }, { name: "pi", pressure: 40, swap: null }],
    accounts: [
      { name: "wouter@kobeco.be", active: true, usage: { session: 0, week: 29, sessionResets: "", weekResets: "6d" } },
      { name: "claude2@denayer.com", active: false, usage: { session: 0, week: 0, sessionResets: "", weekResets: "" } },
    ],
  }),
});
const hBase = new URL(withHistory.url).origin;
const hToken = new URL(withHistory.url).searchParams.get("t");

eq((await fetch(`${hBase}/activity`)).status, 403, "the activity page is behind the same token");
const hPage = await fetch(`${hBase}/activity?t=${hToken}`);
eq(hPage.status, 200, "and is served with it");
const hHtml = await hPage.text();
eq(hHtml.includes("3h12m"), true, "the numbers reach the table");
eq(hHtml.includes('class="account">Wouter<'), false, "with cswap accounts the plain pair is not drawn — the active account is already first");
eq(hHtml.includes("<h2>Accounts</h2>"), false, "and they sit under Rate limits rather than a heading of their own");
eq(hHtml.includes('class="account active">wouter@kobeco.be · active<'), true, "the active one says so");
// `[ >]` keeps the container's class="limits" out of the count, and tolerates
// a row carrying a title tooltip (the swap meter's "occupancy, not activity").
eq((hHtml.match(/class="limit"[ >]/g) ?? []).length, 8, "two per cswap account, two per machine for memory — the live pair is the active account's");
eq(hHtml.includes('title="Occupancy, not activity'), true, "the swap meter says which reading it is");
eq(hHtml.includes("Week resets in 6 days"), true, "a known reset is stated directly in the title, not a separate line");
eq(hHtml.includes('class="lcap lonly">Session reset time is unknown<'), true, "an unknown reset is one centered line and nothing else — no bar, no percentage");
eq(hHtml.includes("<h2>Input tokens<span") && hHtml.includes("cache-read 36M"), true, "input gets its own stacked chart");
eq(hHtml.includes("Memory held by Claude sessions · This Mac<span") && hHtml.includes("17 sessions"), true, "the sessions' own footprint has a chart, named once there are two machines");
eq(hHtml.includes("<h2>Memory pressure · pi<span"), true, "and the host gets its own");
eq(hHtml.includes("Memory held by Claude sessions · pi<span"), false, "but no footprint chart when it never ran a session");
eq(hHtml.includes("<h2>Memory pressure · This Mac<span") && hHtml.includes("swap 90%"), true, "memory pressure over time has its own chart");
eq(hHtml.includes("26.2 GB of 64.0 GB"), true, "the meter says the percentage as an amount");
eq(hHtml.includes("<h2>Memory</h2>") && hHtml.includes("Swap in use</span>"), true, "memory gets its own pair");
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
eq(hHtml.split("<script>").length - 1, 2, "a folder named <script> does not reach the activity page as a third tag, beside the header's own and the page's");
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
// Three token segments, one model bar, two session segments, two token-legend
// swatches, four state-legend swatches — and the two rate-limit meters that
// moved onto the top of this page, which are one fill each.
eq(hHtml.split("<i style=").length - 1, 26, "one element per bar segment, plus the legend swatches and the eight meters");
eq(hHtml.split('class="col unseen"').length - 1, 3, "an unwatched hour is striped rather than empty — in the sessions and both memory charts");
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
  // The activity page absorbed the rate-limit block, so every server that
  // renders it needs both formatters.
  status: async () => ({
    usage: { session: 82, week: 26, sessionResets: "2h", weekResets: "7d" },
    stats: [{ label: "Sessions", value: "4.4k" }],
    blocked: "41m",
    version: "9.9.9",
  }),
});
const nocost = await (await fetch(free.url.replace("/?", "/activity?"))).text();
eq(nocost.includes('class="cost"'), false, "a window with no API review says nothing rather than $0.00");
free.server.close();
const oneVendor = await createConfigServer({
  projects,
  setAccent: () => {},
  reorder: () => {},
  activity: () => ({ ...activity, tokens: { ...activity.tokens, providers: ["claude"] } }),
  // The activity page absorbed the rate-limit block, so every server that
  // renders it needs both formatters.
  status: async () => ({
    usage: { session: 82, week: 26, sessionResets: "2h", weekResets: "7d" },
    stats: [{ label: "Sessions", value: "4.4k" }],
    blocked: "41m",
    version: "9.9.9",
  }),
});
const solo = await (await fetch(oneVendor.url.replace("/?", "/activity?"))).text();
eq(solo.split('class="legend"').length - 1, 2, "one vendor earns no legend of its own — only the input and states charts keep theirs");
oneVendor.server.close();

// The window picker. Links rather than a select, because a select needs a
// script and this page decides everything on the server.
eq(askedFor, null, "no window in the URL asks index.mjs for nothing in particular");
eq(hHtml.split('class="periods"').length - 1, 1, "the picker renders once");
eq(hHtml.includes('href="/activity?t=' + hToken + '&amp;p=7d"'), true, "each window is a link carrying the token");
// Scoped to the picker: the icon header above marks its own current view the
// same way, so counting across the whole document counts both.
const picker = (html) => html.split('class="periods"')[1].split("</div>")[0];
eq(picker(hHtml).split('<a class="on"').length - 1, 1, "exactly one window is marked current");
const weekPage = await (await fetch(`${hBase}/activity?t=${hToken}&p=7d`)).text();
eq(askedFor, "7d", "the window in the URL reaches index.mjs verbatim");
eq(weekPage.includes('<a class="on" href="/activity?t=' + hToken + '&amp;p=7d"'), true, "and the picker marks it");
// An edited URL must not render a picker that disagrees with the charts: the
// page marks whichever window index.mjs says it actually used, never the one
// that was asked for.
// Not "etc": the page's own script legitimately says "fetch", which contains
// it as a substring — a marker with no accidental hits in real page content.
const junkPage = await (await fetch(`${hBase}/activity?t=${hToken}&p=../../nowhere`)).text();
eq(askedFor, "../../nowhere", "an unknown window is passed through rather than guessed at here");
eq(picker(junkPage).split('<a class="on"').length - 1, 1, "and the page still marks exactly one");
eq(junkPage.includes("nowhere"), false, "an unknown window never reaches the document");
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
  status: async () => ({
    usage: { session: 82, week: 26, sessionResets: "2h", weekResets: "7d" },
    stats: [{ label: "Sessions", value: "4.4k" }],
    blocked: "41m",
    version: "9.9.9",
  }),
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

// ---------------------------------------------------------------------------
// The board page: an iPad on the LAN, so everything it renders is escaped and
// everything it posts is checked against the live board rather than trusted.
const focused = [];
const boardKeys = [
  {
    id: "s-1",
    kind: "session",
    project: '<img src=x>"alpha',
    // Not a palette colour, and not a colour at all: readAccents only checks
    // that a stored value is a string, and this one reaches a CSS slot.
    accent: "url(javascript:alert(1))",
    state: "requires_action",
    shell: false,
    label: '<script>alert(1)</script>',
    context: 91,
    squares: ["done", { state: "active", title: '2. Fix "x"' }, "todo"],
    nested: ["busy"],
  },
  { id: "s-2", kind: "session", project: "beta", accent: ACCENTS[1], state: "idle", shell: true, label: "", context: null, squares: [], nested: [] },
  { id: "pi:/x", kind: "offline", project: "x", accent: ACCENTS[2], label: "pi offline 4m" },
  { id: "__usage", kind: "usage", session: 46, week: null },
  // One status tile, not two: attention and free are never both the answer, so
  // the deck and the page both fold them onto one key.
  { id: "__status", kind: "attention", count: 1, longest: "6m" },
];
// One session at length. Everything here is another machine's string for a
// remote project, so the panel escapes the same way the tiles do.
const detail = {
  id: "s-1",
  project: '<b>alpha',
  label: '<script>alert(1)</script>',
  age: "4m",
  accent: "javascript:alert(1)",
  state: "requires_action",
  context: 62,
  model: "opus-5 high",
  host: "pi",
  cwd: "/home/pi/x",
  tasks: [
    { n: 1, subject: "read it", status: "completed" },
    { n: 2, subject: "write it", status: "in_progress" },
    { n: 3, subject: "check it", status: "pending" },
  ],
  nested: [
    { id: "n-1", state: "busy", label: "code-reviewer" },
    // An SDK session walking a plan of its own. This row is the only place on
    // the board it appears, so the count has to be here — and its subject is
    // another tool's file, escaped like everything else.
    { id: "n-2", state: "busy", label: "client-rounds-a", progress: { done: 6, total: 9, active: "<b>Task 6" } },
  ],
};
const boardSrv = await createConfigServer({
  projects,
  setAccent: (...args) => calls.push(args),
  board: async () => ({ keys: boardKeys, projects: projects(), palette: ACCENTS, version: "9.9.9" }),
  focus: (id) => focused.push(id),
  detail: async (id) => (id === "s-1" ? detail : null),
  // All three views share one header, so this server has to be able to render
  // all three of them.
  activity: () => activity,
  reorder: () => {},
  status: async () => ({
    usage: { session: 82, week: 26, sessionResets: "2h", weekResets: "7d" },
    // Untrusted the same way every other label here is — this reaches the page
    // from another tool's cache file.
    stats: [{ label: '<script>alert(1)</script>', value: "66b" }, { label: "Sessions", value: "4.4k" }],
    blocked: "41m",
    version: "9.9.9",
  }),
});
const bBase = new URL(boardSrv.url).origin;
const bToken = boardSrv.token;

eq((await fetch(`${bBase}/board`)).status, 403, "the board is behind the same token gate");
eq((await fetch(`${bBase}/board/grid`)).status, 403, "and so is its poll fragment");

const board = await (await fetch(`${bBase}/board?t=${bToken}`)).text();
eq(board.includes("data-id=\"s-1\""), true, "every tile carries the id its poll diffs on");
eq(board.includes("data-id=\"__usage\""), true, "the reserved keys are tiles like any other");
// Exactly one — the page's own SCRIPT. A second is a project name or a title
// that reached the document as a tag.
eq(board.split("<script>").length - 1, 2, "a project named <img> and a title of <script> do not reach the page as tags, beside the header's own script and the board's");
eq(board.includes("url(javascript"), false, "an accent that is not a hex never reaches a CSS colour slot");
eq(board.includes("background:#555555"), true, "it becomes the neutral instead");
// The session tile alone is tappable; the reserved three and an unreachable
// stand-in carry no data-session, so they are inert by construction.
eq(board.split("data-session=").length - 1, 2, "only the two session tiles are tappable");
// The status tile keeps one id across the fold, so a poll sees it change
// rather than one tile vanishing and another taking its place.
eq(board.includes('data-id="__status"'), true, "the two queues share one tile");
eq(board.includes("CLEAR"), true, "a session with nothing said in it reads CLEAR, as on the deck");

const grid = await (await fetch(`${bBase}/board/grid?t=${bToken}`)).text();
eq(grid.startsWith("<div class=\"key"), true, "the poll fragment is the tiles alone, no page around them");
eq(grid.includes("data-id=\"__status\""), true, "and it is the same list the page was built from");

const bPost = (path, body) =>
  fetch(`${bBase}${path}?t=${bToken}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

eq((await bPost("/focus", { session: "nope" })).status, 400, "an id that is not on the board is refused");
eq((await bPost("/focus", { session: "__usage" })).status, 400, "and so is a reserved tile's");
eq((await bPost("/focus", { session: "pi:/x" })).status, 400, "and an unreachable stand-in's, which has no window to raise");
eq(focused, [], "none of those reached the daemon");
eq((await bPost("/focus", { session: "s-1" })).status, 204, "a live session id is accepted");
eq(focused, ["s-1"], "and is handed over exactly once, unchanged");

// The panel a second tap opens. Not a key layout: the deck's version windows
// its task list to what twelve buttons hold and pins subagents to the tail so
// a long plan can't push them off; this one shows all of both.
eq((await fetch(`${bBase}/session?id=s-1`)).status, 403, "the panel is behind the token gate too");
const panel = await (await fetch(`${bBase}/session?t=${bToken}&id=s-1`)).text();
eq(panel.split("<script>").length - 1, 0, "a title of <script> does not reach the panel as a tag");
eq(panel.includes("javascript:alert"), false, "an accent that is not a hex never reaches the stripe's colour slot");
eq(panel.split('class="task ').length - 1, 3, "every task is listed, not a window of them");
eq(panel.includes("in_progress"), true, "and carries its status, so the running one reads as running");
eq(panel.includes("1 of 3"), true, "with the count the deck's progress bar shows");
eq(panel.split('class="agent"').length - 1, 2, "every subagent too");
eq(panel.includes("6/9 · busy"), true, "an SDK session's own task count rides its row — it has no key of its own to carry it");
eq(panel.includes("<em>&lt;b&gt;Task 6</em>"), true, "and the task it is on, escaped like every other borrowed string");
eq(panel.includes("<span class=\"st\">busy</span>"), true, "a subagent with no plan of its own still reads as it did");
eq(panel.includes("pi:/home/pi/x"), true, "a remote session says which host it is on");
eq(panel.includes("blocked on you"), true, "requires_action is spelled out where there is room for it");
eq(panel.includes("<dt>Account</dt><dd>—</dd>"), true, "a remote session's account is honestly unknown, not guessed at");

// Both "you made that up" and "it ended while you were looking at it" — the
// panel says the same thing either way rather than the handler guessing.
const gone = await (await fetch(`${bBase}/session?t=${bToken}&id=../../etc/passwd`)).text();
eq(gone.includes("has ended"), true, "an id nothing matches says the session has ended");
eq(gone.includes("class=\"task"), false, "and shows nothing stale");

// The settings sheet says which build you are looking at, which is the one
// question a board on a wall cannot otherwise answer.
eq(board.includes('<p class="sver">Claude Deck v9.9.9</p>'), true, "the sheet carries the version");

// The rate-limit windows and the all-time totals sit on top of the activity
// page rather than on a page of their own. Formatted unlike a key on purpose:
// the deck spends two whole keys saying "Session reset 3h", because 72px
// cannot hold a percentage and the window it is a percentage *of* at once.
eq((await fetch(`${bBase}/status?t=${bToken}`)).status, 404, "the page they used to live on is gone");
const act = await (await fetch(`${bBase}/activity?t=${bToken}`)).text();
eq(act.includes("82%"), true, "the session window's percentage is on the activity page");
eq(act.includes("Session resets in 2 hours"), true, "the reset is stated directly in the title");
eq(act.includes("Week resets in 7 days"), true, "and the same for the week");
eq(act.includes("41m"), true, "today's blocked time, which the deck lost a slot for once");
eq(act.includes("9.9.9"), true, "and the daemon's own version");
eq(act.split("<script>").length - 1, 2, "a stat label named <script> does not reach it as a third tag, beside the header's own and the page's");
// Above the picker, because no window applies to them: a 5-hour rate limit is
// not a thing you look at "over 30 days".
eq(act.indexOf("Rate limits") < act.indexOf('class="periods"'), true,
   "they sit above the window picker, which does not govern them");

// The usage tile is the other way in. An anchor rather than a click handler:
// it is a navigation, so it needs nothing from SCRIPT and survives the poll's
// diffing unchanged.
eq(board.includes(`<a class="key dark tile" href="/activity?t=${bToken}"`), true,
   "the usage tile links there, carrying the token");
eq(grid.includes(`href="/activity?t=${bToken}"`), true, "and so does the tile the poll swaps in");

// One header on all three views. It was icons on the board and text links on
// the config pages, which made "where am I and how do I get back" a different
// question depending on where you already were.
for (const [path, here] of [["/board", "board"], ["/activity", "activity"], ["/", "accents"]]) {
  const html = await (await fetch(`${bBase}${path}?t=${bToken}`)).text();
  const head = html.split('class="head"')[1].split("</header>")[0];
  eq(head.split('class="icon').length - 1, 3, `${path} carries all three destinations`);
  // The accents page is not one of the three destinations — it is where the
  // deck's own config key lands, and it keeps drag-to-reorder — so nothing is
  // marked there rather than something being marked arbitrarily.
  eq(head.split('class="icon on"').length - 1, here === "accents" ? 0 : 1, `${path} marks the right icon current`);
  eq(head.includes(`href="/board?t=${bToken}"`), true, `${path} links the board with the token`);
  eq(head.includes(`href="/activity?t=${bToken}"`), true, `${path} links activity with the token`);
  // The gear ends in the same place from every page: the board's settings
  // sheet. On the board it toggles it; elsewhere it links to the board with
  // the sheet already open. It pointed at the accents page from the config
  // pages for one release, which is the one thing a fixed icon bar exists to
  // prevent.
  eq(
    here === "board" ? head.includes('id="gear"') : head.includes(`href="/board?t=${bToken}&amp;settings=1"`),
    true,
    `${path}'s gear leads to the same settings as everywhere else`
  );
  eq(head.includes(`href="/?t=`), false, `${path} does not send the gear somewhere of its own`);
}

// What turns a saved bookmark into a home-screen app. Neither platform lets a
// page install itself, so the only thing under this project's control is that
// what you do save opens a board rather than a 403 — which is entirely about
// the token surviving into start_url.
const manifestRes = await fetch(`${bBase}/manifest.webmanifest?t=${bToken}`);
eq(manifestRes.status, 200, "the manifest is served");
eq(manifestRes.headers.get("content-type").startsWith("application/manifest+json"), true, "as a manifest");
const manifest = JSON.parse(await manifestRes.text());
eq(manifest.start_url, `/board?t=${bToken}`, "start_url carries the token, or the installed icon opens a 403");
eq(manifest.display, "standalone", "and opens without browser chrome");
eq(
  manifest.icons.every((i) => i.src.includes(`t=${bToken}`)),
  true,
  "so does every icon it names — they are behind the same gate as everything else"
);
eq((await fetch(`${bBase}/manifest.webmanifest`)).status, 403, "and the manifest itself is gated, since it holds the token");

const iconRes = await fetch(`${bBase}/icon-180.png?t=${bToken}`);
eq(iconRes.status, 200, "the apple-touch icon is served");
eq(iconRes.headers.get("content-type"), "image/png", "as a png, which is the only thing iOS accepts here");
eq((await iconRes.arrayBuffer()).byteLength > 0, true, "with bytes in it");
eq((await fetch(`${bBase}/icon-64.png?t=${bToken}`)).status, 404, "a size nothing asks for is not rendered on demand");
eq((await fetch(`${bBase}/icon-180.png`)).status, 403, "and icons are gated too");

// The favicon is the home-screen icon at tab sizes, on every page.
import { FAVICON_SIZES } from "../src/board-page.mjs";
for (const size of FAVICON_SIZES) {
  const r = await fetch(`${bBase}/icon-${size}.png?t=${bToken}`);
  eq(r.status, 200, `icon-${size} is served`);
  const png = Buffer.from(await r.arrayBuffer());
  eq(png.readUInt32BE(16), size, `and is ${size}px wide`);
}
const accentsPage = await (await fetch(`${bBase}/?t=${bToken}`)).text();
for (const [name, html] of [["board", board], ["activity", act], ["accents", accentsPage]]) {
  eq(html.includes(`rel="icon" type="image/png" sizes="32x32" href="/icon-32.png?t=${bToken}"`), true, `${name} links a 32px favicon`);
  eq(html.includes(`rel="apple-touch-icon" sizes="180x180" href="/icon-180.png?t=${bToken}"`), true, `${name} links the touch icon`);
}

eq(grid.includes('<i class="active" title="2. Fix &quot;x&quot;"></i>'), true, "a task square carries its subject as a tooltip, escaped");

const boardHead = board.slice(0, board.indexOf("</head>"));
eq(boardHead.includes(`rel="manifest" href="/manifest.webmanifest?t=${bToken}"`), true, "the page links its manifest with the token");
eq(boardHead.includes(`rel="apple-touch-icon" sizes="180x180" href="/icon-180.png?t=${bToken}"`), true, "and its apple-touch icon");
// iOS never fires beforeinstallprompt, so the button starts hidden and the
// instructions start visible; Android's event swaps them.
eq(board.includes('<button id="install" hidden>'), true, "the install button is hidden until a browser offers one");

// The board's settings sheet posts the same accent mutation the config page's
// form does, but has no page to be redirected to.
calls = [];
eq((await bPost("/accent", { folder: ALPHA, accent: ACCENTS[3] })).status, 200, "the form POST still follows its 303 to the page");
const fromBoard = await fetch(`${bBase}/accent?t=${bToken}&from=board`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ folder: ALPHA, accent: ACCENTS[4] }),
});
eq(fromBoard.status, 204, "the board's POST answers 204 and leaves the page where it is");
eq(calls, [[ALPHA, ACCENTS[3]], [ALPHA, ACCENTS[4]]], "both routes mutate the same way");

boardSrv.server.close();

// ---------------------------------------------------------------------------
// The remembered address. A page left open on an iPad has to reconnect after a
// daemon restart, which needs the *same* port and the same token — a fixed
// port with a fresh token every start is still a dead bookmark.
{
  const dir = mkdtempSync(join(tmpdir(), "board-state-"));
  eq(readBoardState(dir), { port: null, token: null }, "a first run remembers nothing");
  const token = "3f7bd51c-7c87-4bf2-b784-e4d0a3320eec";
  writeBoardState({ port: 8765, token }, dir);
  eq(readBoardState(dir), { port: 8765, token }, "and reads back exactly what it wrote");
  // It holds a bearer token for a service on the LAN, which is not the same
  // kind of thing as a colour map.
  eq(statSync(join(dir, "streamdeck-board.json")).mode & 0o777, 0o600, "the file is owner-only");

  // Every field is validated: this is small enough to hand-edit, the port
  // reaches listen() and the token is compared against a query parameter.
  // Per field, not all-or-nothing: a hand-edited port should not throw away a
  // working token, and a token this never wrote must not be accepted whatever
  // the port beside it says.
  const after = (obj) => {
    writeFileSync(join(dir, "streamdeck-board.json"), JSON.stringify(obj));
    return readBoardState(dir);
  };
  eq(after({ port: 99999, token }), { port: null, token }, "a port outside the usable range is dropped, the token kept");
  eq(after({ port: 0, token }).port, null, "and so is a zero port, which means ephemeral rather than remembered");
  eq(after({ port: 8765, token: "letmein" }), { port: 8765, token: null }, "a token this never wrote is refused");
  writeFileSync(join(dir, "streamdeck-board.json"), "{not json");
  eq(readBoardState(dir), { port: null, token: null }, "a corrupt file is a first run, not a throw");
  rmSync(dir, { recursive: true, force: true });
  eq(readBoardState(dir), { port: null, token: null }, "and so is a missing one");
}

// A port already in use must not stop the board coming up — it degrades to an
// ephemeral one and says so, because an old bookmark silently reaching nothing
// is the failure you would waste an evening on.
{
  const held = await createConfigServer({ projects: () => [] });
  const taken = held.port;
  const a = await createConfigServer({ projects: () => [] }, "127.0.0.1", { port: taken });
  eq(a.port === taken, false, "a taken port is not where the board lands");
  eq(typeof a.warning === "string" && a.warning.includes(String(taken)), true, "and the caller is told which port it wanted");
  eq(a.warning.includes(String(a.port)), true, "and which one it got instead");
  const b = await createConfigServer({ projects: () => [] }, "127.0.0.1", { port: 0 });
  eq(b.warning, null, "a port that was free warns about nothing");
  held.server.close();
  a.server.close();
  b.server.close();
}

// What gets remembered after a clash is the port to *try*, never the ephemeral
// one it settled for: the squatter is the thing that goes away, and the next
// run has to ask for the standard port again rather than chase a number that
// meant nothing. Driven through the real file, since that is the whole claim.
{
  const dir = mkdtempSync(join(tmpdir(), "board-clash-"));
  const file = join(dir, "streamdeck-board.json");
  writeBoardState({ port: 8765, token: "3f7bd51c-7c87-4bf2-b784-e4d0a3320eec" }, dir);
  eq(readBoardState(dir).port, 8765, "the preferred port round-trips");
  writeBoardState({ port: 8765, token: readBoardState(dir).token }, dir);
  eq(JSON.parse(readFileSync(file, "utf8")).port, 8765, "and is what a later run reads back, not a fallback");
  rmSync(dir, { recursive: true, force: true });
}

eq(DEFAULT_PORT, 8765, "the default port is fixed, not ephemeral");

// lanAddress picks the first non-internal IPv4 and nothing else — a machine
// with only loopback has no board address, which is a null rather than a lie.
eq(lanAddress({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }] }), null, "loopback is not a LAN address");
eq(lanAddress({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }], en0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.2.28", internal: false }] }), "192.168.2.28", "the first non-internal IPv4 wins");
eq(lanAddress({}), null, "no interfaces at all is null, not a throw");

console.log("OK: token gate, palette and folder validation, escaping, swatch count, redirect, reorder, activity page and charts, board page, detail panel, shared header, focus and lanAddress");

// A compacting tile: busy green with the spinning ring, never idle grey with a
// bare word (STATE_COLORS has no `compacting` entry, so the lookup fell through).
{
  const { boardGrid } = await import("../src/board-page.mjs");
  const { STATE_COLORS } = await import("../src/render.mjs");
  const html = boardGrid([{ id: "abc", kind: "session", state: "compacting", label: "x", project: "p", accent: "#fff" }], "t");
  if (!html.includes(`background:${STATE_COLORS.busy}`) || !html.includes('class="compact"')) {
    console.error("FAIL: compacting tile", html);
    process.exit(1);
  }
}

// The status tile's resting readout. The deck's key names whichever board is
// up — SESSIONS at rest, FREE and WORKING on the two its cycle opens — and
// the page has no cycle, so it only ever renders the resting one. Same
// `statusKey` fold either way, which is the whole reason that function is
// exported rather than being a branch inside each board's own draw call.
{
  const { boardGrid } = await import("../src/board-page.mjs");
  const resting = boardGrid([{ id: "__status", kind: "sessions", count: 14 }], "t");
  eq(resting.includes(">14<"), true, "the resting status tile counts every session");
  eq(resting.includes(">sessions<"), true, "and says so, rather than naming a board it is not showing");
  eq(resting.includes("alert"), false, "nothing is wrong, so nothing is red");
  const blocked = boardGrid([{ id: "__status", kind: "attention", count: 2, longest: "6m" }], "t");
  eq(blocked.includes(">blocked<") && blocked.includes("alert"), true, "the attention side still reads as an alarm");
}
console.log("OK: status tile");
