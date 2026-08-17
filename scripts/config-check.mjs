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
eq(html.includes("<script>"), false, "a folder named <script> does not reach the page as a tag");
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

// An empty board says so rather than rendering an empty page.
const { server: empty, url: emptyUrl } = await createConfigServer({ projects: () => [], setAccent: () => {} });
eq((await (await fetch(emptyUrl)).text()).includes("nothing on the board"), true, "an empty board says so");
empty.close();

server.close();
console.log("OK: token gate, palette and folder validation, escaping, swatch count, redirect");
