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

// The history page. Rows arrive already formatted — index.mjs owns the
// summarising and the clock, this file owns the markup — so the check renders
// a table from fixed strings rather than reconstructing a day of transitions.
const historyRows = [
  { key: ALPHA, name: "alpha", today: { busy: "3h12m", waiting: "41m", blocked: "18m" }, week: { busy: "9h", waiting: "2h", blocked: "51m" } },
  { key: NASTY, name: '<script>"x', today: { busy: "—", waiting: "—", blocked: "—" }, week: { busy: "4m", waiting: "—", blocked: "—" } },
];
const withHistory = await createConfigServer({ projects, setAccent: () => {}, reorder: () => {}, history: () => historyRows });
const hBase = new URL(withHistory.url).origin;
const hToken = new URL(withHistory.url).searchParams.get("t");

eq((await fetch(`${hBase}/history`)).status, 403, "the history page is behind the same token");
const hPage = await fetch(`${hBase}/history?t=${hToken}`);
eq(hPage.status, 200, "and is served with it");
const hHtml = await hPage.text();
eq(hHtml.includes("3h12m"), true, "today's numbers reach the table");
eq(hHtml.includes("9h"), true, "and the week's");
// Both tables render the same rows, so every row appears twice.
eq(hHtml.split('class="project"').length - 1, 4, "two rows in each of the two tables");
// A project name is untrusted here for exactly the reason it is on the other
// page, and this table is a second place it reaches the document.
eq(hHtml.split("<script>").length - 1, 0, "a folder named <script> does not reach the history page as a tag");
eq(hHtml.includes("&lt;script&gt;"), true, "it is escaped there too");
// The blocked column is coloured to draw the eye to real blocked time, so a
// row with none must not wear it. Four blocked cells across the two tables:
// alpha has a value in both, the second row is an em dash in both.
eq(hHtml.split('class="blocked"').length - 1, 2, "an em dash in the blocked column is not coloured");

const emptyHistory = await createConfigServer({ projects, setAccent: () => {}, reorder: () => {}, history: () => [] });
eq(
  (await (await fetch(new URL(emptyHistory.url).origin + "/history?t=" + new URL(emptyHistory.url).searchParams.get("t"))).text()).includes("no history recorded yet"),
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
console.log("OK: token gate, palette and folder validation, escaping, swatch count, redirect, reorder, history page");
