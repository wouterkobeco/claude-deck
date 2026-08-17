# Config Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web page, served by the daemon and opened from a key on the Stream Deck's stats board, that sets which of the eight accent colours each live project wears.

**Architecture:** The daemon starts a `node:http` server on loopback with a random port and a random token when the config key is pressed, and opens the browser at that URL. The page is server-rendered HTML; each project row is a form whose eight swatch buttons POST a colour. The POST calls back into `index.mjs`, which swaps the colour with whichever live project held it and persists via the existing `accents.mjs`. The next 2s poll redraws the keys.

**Tech Stack:** Node built-ins only (`node:http`, `node:crypto`, `node:child_process`). No new dependencies, no build step, no client-side JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-17-config-web-ui-design.md`

## Global Constraints

- **No new dependencies.** The project has exactly two (`@elgato-stream-deck/node`, `sharp`) and adds none here.
- **ESM only.** `.mjs`, `"type": "module"`. Every import is `node:`-prefixed for built-ins.
- **macOS only.** `execFile("open", [url])` is the browser launcher; this is already true of the whole daemon.
- **The palette is a closed set of eight**, `ACCENTS`. Nothing may introduce a ninth colour or accept a colour outside it.
- **Every new failure path degrades to nothing**, never throws into the poll loop or the press handler. This matches `vscode-state.mjs`, `terminal-focus.mjs` and `accents.mjs`.
- **Checks are plain scripts:** `node scripts/<thing>-check.mjs`, importing from `src/`, comparing to expected values, `process.exit(1)` on mismatch. No framework, no runner, no assertions library.
- **`package.json` and `extension/package.json` versions must stay equal** — `terminal-focus-check` enforces it. Bump both, patch level, in the final task.
- **Dependency already in place:** roadmap item 1 (persisted accents) is implemented in the working tree — `src/accents.mjs`, `loadAccents`, `persistAccents`, and the `assignSlots` collision rule all exist. Do not re-implement them.

---

### Task 1: Accent palette and the pure swap

Moves `ACCENTS` into `accents.mjs` so `config-server.mjs` can import it without a cycle, and adds the swap as a **pure** function there. Pure matters: `index.mjs`'s `persistAccents` writes the real `~/.claude/streamdeck-accents.json`, so a swap that persisted and was exported for a check would clobber the user's file with fixture folders on every check run.

**Files:**
- Modify: `src/accents.mjs`
- Modify: `src/index.mjs` (the `ACCENTS` const block, ~lines 40-50, and the `accents.mjs` import)
- Test: `scripts/slots-check.mjs` (append to the accent section, after the round-trip cases)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ACCENTS: string[]` exported from `src/accents.mjs` (8 hex strings), re-exported from `src/index.mjs`.
  - `applyAccentChoice(accents: Map<string,string>, liveKeys: Set<string>, folder: string, accent: string): void` — mutates `accents` in place, returns nothing.

- [ ] **Step 1: Write the failing test**

Append to `scripts/slots-check.mjs`, immediately after the `rmSync(accentDir, ...)` line that ends the round-trip cases:

```js
// The swap the config UI performs, kept pure and kept here rather than beside
// persistAccents: that function writes the real ~/.claude file with no root
// argument, so an exported mutator that persisted would clobber this machine's
// accents with fixture folders every time the checks run.
const P = "/projects/pick";
const Q = "/projects/quill";
const R = "/projects/closed";

// Both live, Q holds what P wants: they trade, so no colour is ever duplicated
// among live folders and assignSlots' collision rule has nothing to resolve.
const swapped = new Map([[P, ACCENTS[0]], [Q, ACCENTS[1]]]);
applyAccentChoice(swapped, new Set([P, Q]), P, ACCENTS[1]);
eq([...swapped], [[P, ACCENTS[1]], [Q, ACCENTS[0]]], "a swap trades both ways");

// Nobody holds it: nobody else changes.
const free = new Map([[P, ACCENTS[0]], [Q, ACCENTS[1]]]);
applyAccentChoice(free, new Set([P, Q]), P, ACCENTS[4]);
eq([...free], [[P, ACCENTS[4]], [Q, ACCENTS[1]]], "picking a free colour changes nobody else");

// A remembered-but-closed folder holds it. Trading with something that isn't
// on the board would be invisible, and leaving the duplicate in the file means
// the collision rule picks a winner by readdir order when it reopens — half
// the time taking back a colour you deliberately assigned. Drop its entry: it
// re-claims like any new arrival.
const closed = new Map([[P, ACCENTS[0]], [R, ACCENTS[2]]]);
applyAccentChoice(closed, new Set([P]), P, ACCENTS[2]);
eq([...closed], [[P, ACCENTS[2]]], "a closed owner's entry is dropped, not duplicated");

// ...and the pick then survives that folder coming back: with no duplicate in
// the map, assignSlots claims a free colour for the returning folder and
// leaves the hand-picked one alone.
loadAccents([...closed]);
assignSlots([s("pick", P), s("back", R)], wide);
eq(accentFor(P), ACCENTS[2], "a manual pick survives the closed folder reopening");
eq(accentFor(R) !== ACCENTS[2], true, "and the returning folder takes something else");
```

Add `applyAccentChoice` to the existing `../src/accents.mjs` import at the top of the file:

```js
import { readAccents, writeAccents, applyAccentChoice } from "../src/accents.mjs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run slots-check`
Expected: FAIL — `SyntaxError` / `does not provide an export named 'applyAccentChoice'`.

- [ ] **Step 3: Move ACCENTS into accents.mjs**

Cut this block from `src/index.mjs` (the comment and the const, ~lines 40-50) and paste it into `src/accents.mjs` directly below the `fileIn` helper, with `export` kept:

```js
// Accent colours identifying which VS Code window a session belongs to.
// Assigned in first-seen order rather than by hashing the path: hashing is
// stable across restarts but can hand two windows the same colour, and
// telling windows apart is the whole point. Sorting would instead reshuffle
// existing colours whenever a new window appears.
// All eight are light (L* 57–94): the accent bar carries dark caps text, and it
// has to separate from the state colour filling the rest of the key. The last
// slot is a light warm grey rather than the brown 300 it was — brown sat only
// 25 ΔE from the idle grey background, the closest any accent came to a state,
// and it was the accent doing the least to say which project this is.
export const ACCENTS = ["#4fc3f7", "#ff8a65", "#ba68c8", "#fff176", "#4db6ac", "#f06292", "#aed581", "#bcaaa4"];
```

In `src/index.mjs`, replace the removed block by extending the existing import and re-exporting, so `colors-check` and `slots-check` keep importing `ACCENTS` from `index.mjs` unchanged:

```js
import { ACCENTS, readAccents, writeAccents, applyAccentChoice } from "./accents.mjs";

// Re-exported rather than defined here: config-server.mjs needs the palette,
// index.mjs needs openConfig from config-server.mjs, and one of those edges
// has to not exist. colors-check and slots-check import it from here.
export { ACCENTS };
```

- [ ] **Step 4: Add the pure swap to accents.mjs**

Append to `src/accents.mjs`:

```js
/**
 * Give `folder` the colour `accent`, keeping "no two live folders share one".
 *
 * Pure and parameterised rather than reaching for the module's own map,
 * because the persisting caller lives in index.mjs and writes the real
 * ~/.claude file — see persistAccents' comment there. A check drives this;
 * nothing drives that.
 *
 * A *live* folder wearing that colour trades: it takes what `folder` gave up,
 * so the swap is closed and assignSlots' collision rule never has to fire on a
 * hand-made choice. A *closed* one is dropped instead of traded — handing a
 * colour to something that isn't on the board is invisible, and leaving the
 * duplicate in the file means that folder's return is resolved by iteration
 * order, which is effectively readdir order and would silently take a
 * deliberate choice back days later.
 *
 * `folder` having no previous colour can't happen from the UI (every live
 * folder has one by the time it is listed) but is handled the same way as a
 * closed owner rather than left to create a duplicate.
 */
export function applyAccentChoice(accents, liveKeys, folder, accent) {
  const previous = accents.get(folder);
  for (const [f, c] of [...accents]) {
    if (f === folder || c !== accent) continue;
    if (liveKeys.has(f) && previous) accents.set(f, previous);
    else accents.delete(f);
  }
  accents.set(folder, accent);
}
```

- [ ] **Step 5: Run the checks**

Run: `npm run slots-check && npm run colors-check`
Expected: both PASS. `colors-check` matters here — it imports `ACCENTS` from `index.mjs` and proves the re-export works.

- [ ] **Step 6: Prove the new case isn't vacuous**

Temporarily change `else accents.delete(f);` to `else { /* nothing */ }` in `src/accents.mjs`.
Run: `npm run slots-check`
Expected: FAIL with `a closed owner's entry is dropped, not duplicated`.
Then restore the line and re-run to confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add src/accents.mjs src/index.mjs scripts/slots-check.mjs
git commit -m "refactor: move ACCENTS into accents.mjs and add the pure accent swap"
```

---

### Task 2: The config server

A standalone HTTP server with its daemon coupling entirely in an injected `deps` object, so the check drives the real server with fakes — no deck, no `~/.claude`, no browser.

**Files:**
- Create: `src/config-server.mjs`
- Create: `scripts/config-check.mjs`
- Modify: `package.json` (add the `config-check` script)

**Interfaces:**
- Consumes: `ACCENTS` from `src/accents.mjs` (Task 1).
- Produces:
  - `createConfigServer(deps): Promise<{ server: http.Server, url: string }>` — already listening on `127.0.0.1` on a free port; `url` includes the token as `?t=`.
  - `openConfig(deps): Promise<void>` — starts the server on first call, reuses it after, opens the browser. Never throws.
  - `deps` is `{ projects(): Array<{key: string, name: string, host: string|null, accent: string}>, setAccent(key: string, accent: string): void }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/config-check.mjs`:

```js
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
eq(html.includes("Referrer-Policy"), false, "the policy is a header, not markup");
eq(page.headers.get("referrer-policy"), "no-referrer", "the token cannot travel in a Referer");

// Escaping: neither an element nor an attribute break-out survives.
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

eq((await post(`folder=${encodeURIComponent(ALPHA)}&accent=${encodeURIComponent(ACCENTS[1])}`, "wrong")).status, 403, "a POST with a bad token is refused");
eq(calls.length, 0, "and nothing was mutated");

eq((await post(`folder=%2Fprojects%2Fgone&accent=${encodeURIComponent(ACCENTS[1])}`)).status, 400, "a folder that is not live is refused");
eq(calls.length, 0, "and nothing was mutated");

eq((await post(`folder=${encodeURIComponent(ALPHA)}&accent=${encodeURIComponent("x".repeat(5000))}`)).status, 400, "an oversized body is refused");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/config-check.mjs`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `src/config-server.mjs`.

- [ ] **Step 3: Write the server**

Create `src/config-server.mjs`:

```js
// The config page: a local web UI, opened from the stats board's config key,
// for setting which accent each live project wears.
//
// Server-rendered HTML with form POSTs rather than a JSON API and client-side
// rendering. The deciding reason is this project's quality model: every
// non-trivial module here has a plain scripts/*-check.mjs that imports it and
// asserts, and a POST handler is the most checkable thing available — a real
// server on port 0, a real fetch, an assertion. Client JS inside a template
// literal is the least: nothing in this repo can lint it, import it or run it.
// When drag-to-reorder arrives and the page needs real interactivity, the page
// renderer is rewritten and colour picking moves onto the same flow in that
// same pass, so the page never runs two paradigms at once. `deps` below is
// what keeps that rewrite to one function.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { ACCENTS } from "./accents.mjs";

// A form POST of one folder key and one hex value. Anything approaching this
// is not a browser filling in the page we served.
const MAX_BODY = 4096;

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// The full five-entity escape, not tags only. Folder keys reach this page from
// the filesystem and, for a remote project, from another machine's registry —
// and the hidden `folder` field puts them in *attribute* context, where a
// double quote breaks out with no `<` involved. A tag-only escaper passes a
// `<script>` test case while still being injectable.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

const STYLE = `
  :root { color-scheme: dark }
  body { background:#121212; color:#e0e0e0; font-family:-apple-system,sans-serif;
         margin:0; padding:32px; }
  h1 { font-size:15px; letter-spacing:.18em; text-transform:uppercase;
       color:#9e9e9e; font-weight:600; margin:0 0 24px }
  .row { margin:0 0 20px; max-width:520px }
  .bar { padding:6px 10px; border-radius:4px 4px 0 0; color:#000000bb;
         font-size:12px; font-weight:700; letter-spacing:.12em;
         text-transform:uppercase }
  .key { background:#1b1b1b; padding:5px 10px; font-size:11px; color:#757575;
         font-family:ui-monospace,monospace; word-break:break-all }
  .swatches { display:flex; gap:6px; margin-top:8px }
  button { width:44px; height:28px; border:2px solid transparent; border-radius:4px;
           cursor:pointer; padding:0 }
  button.on { border-color:#ffffff }
  .empty { color:#757575 }`;

function page(token, projects) {
  const rows = projects
    .map(
      (p) => `
    <form class="row" method="post" action="/accent?t=${esc(token)}">
      <input type="hidden" name="folder" value="${esc(p.key)}">
      <div class="bar" style="background:${esc(p.accent)}">${esc(p.name)}</div>
      <div class="key">${esc(p.key)}</div>
      <div class="swatches">${ACCENTS.map(
        (c) =>
          `<button name="accent" value="${c}" style="background:${c}"${c === p.accent ? ' class="on"' : ""} title="${c}"></button>`
      ).join("")}</div>
    </form>`
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>streamdeck config</title>
    <style>${STYLE}</style></head><body>
    <h1>Project accents</h1>
    ${rows || '<p class="empty">nothing on the board right now</p>'}
    </body></html>`;
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * A listening server and the URL that opens it. Does not touch a browser.
 *
 * Loopback-bound, so nothing off this machine can reach it whatever else is
 * true, and gated on a per-server randomUUID, so no other local process — and
 * no page you happen to have open — can POST to it either. Compared with !==
 * rather than timingSafeEqual: it is 122 random bits over loopback, and
 * anything else would be theatre.
 */
export async function createConfigServer(deps) {
  const token = randomUUID();

  const server = createServer(async (req, res) => {
    // Set on every response, including the 403s. The page has no external
    // links today, so nothing leaks today — but the token is in the URL, and
    // one header is cheaper than remembering that constraint forever.
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      // Before routing, so an unknown path without a token doesn't confirm
      // that the path is unknown.
      if (url.searchParams.get("t") !== token) return send(res, 403, "forbidden");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, page(token, deps.projects()), "text/html; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/accent") {
        const form = new URLSearchParams(await readBody(req));
        const folder = form.get("folder");
        const accent = form.get("accent");
        // The palette is a closed set, so this is an exact-match test rather
        // than a "looks like hex" one: colors-check's contrast and separation
        // floors cover these eight strings and nothing else.
        if (!ACCENTS.includes(accent)) return send(res, 400, "unknown accent");
        // A page left open until its project closed can't write a colour for
        // it, and nothing arbitrary ever enters the accent map.
        if (!deps.projects().some((p) => p.key === folder)) return send(res, 400, "unknown project");
        deps.setAccent(folder, accent);
        // A dead end on 400 by contrast: only a stale page or a forged request
        // gets one, and the way back for both is the config key.
        res.writeHead(303, { Location: `/?t=${token}` });
        return res.end();
      }

      return send(res, 404, "not found");
    } catch {
      // An oversized or aborted body, or a URL Node won't parse. Never let it
      // reach the daemon's unhandled-rejection path.
      if (!res.headersSent) send(res, 400, "bad request");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/?t=${token}` };
}

// Started by the first press and kept for the daemon's life: an idle shutdown
// is a timer to get wrong, and the port doesn't exist until you've asked for
// it. The *promise* is memoised, not its result, so two fast presses can't
// start two servers.
let running = null;

export async function openConfig(deps) {
  try {
    running ??= createConfigServer(deps);
    const { url } = await running;
    console.log(`config: ${url}`);
    execFile("open", [url], () => {});
  } catch (err) {
    // Best-effort like every other risky path here: the URL is on stdout above
    // when it got that far, and the deck is untouched either way.
    running = null;
    console.error("config server failed:", err?.message ?? err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/config-check.mjs`
Expected: PASS — `OK: token gate, palette and folder validation, escaping, swatch count, redirect`

- [ ] **Step 5: Prove the escaping case isn't vacuous**

Temporarily change `esc` to a tag-only escaper:

```js
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ENTITIES[c]);
```

Run: `node scripts/config-check.mjs`
Expected: FAIL with `and the quote does not break out of the hidden field`. This is the point of the case — a tag-only escaper still passes the `<script>` assertions. Restore `esc` and re-run to confirm PASS.

- [ ] **Step 6: Add the npm script**

In `package.json`, after the `"remote-install-check"` entry:

```json
"config-check": "node scripts/config-check.mjs",
```

- [ ] **Step 7: Commit**

```bash
git add src/config-server.mjs scripts/config-check.mjs package.json
git commit -m "feat: config web server for setting project accents"
```

---

### Task 3: The config key's tile

Generalises `renderBack` so one function draws both the back key and the config key. The defaults are the current hardcoded values, so both existing call sites are unchanged.

**Files:**
- Modify: `src/render.mjs` (`renderBack`, ~line 671)
- Test: `scripts/render-check.mjs` (beside the existing back-key case, ~line 359)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderBack({ width, height, glyph = "←", caps = "BACK" })` → `Promise<Buffer>` (raw RGBA, `width * height * 4` bytes).

- [ ] **Step 1: Write the failing test**

In `scripts/render-check.mjs`, replace the existing back-key block (the `const backBuf = ...` through the `.toFile(...render-check-back.png...)` call) with:

```js
const backBuf = await renderBack({ width, height });
if (backBuf.length !== expected) {
  console.error(`FAILED (back key): expected ${expected} bytes, got ${backBuf.length}`);
  process.exit(1);
}
await sharp(backBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-back.png", import.meta.url).pathname);

// The same function draws the config key on the stats board. Glyph coverage is
// not assumed: "⚙" (U+2699) has to survive librsvg and whatever sans-serif
// resolves to here, which is exactly the class of thing this project reads back
// off the raster rather than trusting (see the CHAR_WIDTH case above). Ink in
// the glyph band proves *something* drew; render-check-config.png is what tells
// a human it isn't a tofu box, the same way the other PNGs here work.
const configBuf = await renderBack({ width, height, glyph: "⚙", caps: "CONFIG" });
const blankBuf = await renderBack({ width, height, glyph: " ", caps: "CONFIG" });
// Rows 0 to 65% of the key: the glyph sits at y = height * 0.44, the caps at
// 0.78, so this band is the glyph's alone.
const inkIn = (buf) => {
  let n = 0;
  for (let y = 0; y < Math.round(height * 0.65); y++) {
    for (let x = 0; x < width; x++) {
      if (buf[(y * width + x) * 4] > 40) n++;
    }
  }
  return n;
};
const glyphInk = inkIn(configBuf) - inkIn(blankBuf);
if (glyphInk < 40) {
  console.error(`FAILED (config key glyph): only ${glyphInk}px of ink above the caps — did ⚙ resolve?`);
  process.exit(1);
}
await sharp(configBuf, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(new URL("./render-check-config.png", import.meta.url).pathname);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run render-check`
Expected: FAIL with `FAILED (config key glyph): only 0px of ink above the caps` — `renderBack` still ignores `glyph`, so both renders draw the same `←`.

- [ ] **Step 3: Generalise renderBack**

In `src/render.mjs`, change the signature and the two hardcoded strings. `glyph` and `caps` are this project's own literals, never user input, so they are interpolated as-is:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run render-check`
Expected: PASS.

- [ ] **Step 5: Look at the raster**

Open `scripts/render-check-config.png`. CLAUDE.md: layout changes need render-check *looked at*, not just run. Confirm the gear is a gear and not a `􏿽` box or an empty square. If it is a box, replace the glyph with a drawn SVG shape (two concentric `<circle>`s) in Step 3 and re-run — the ink assertion passes either way, which is why this step exists.

- [ ] **Step 6: Commit**

```bash
git add src/render.mjs scripts/render-check.mjs scripts/render-check-back.png scripts/render-check-config.png
git commit -m "feat: renderBack takes a glyph and caps, for the config key"
```

---

### Task 4: Wire the config key into the daemon

The glue: the live-project set the page renders and the swap searches, the persisting `setAccent` wrapper, the tile, the press branch, the docs, and the guard comments this change invalidates. Not unit-testable — it needs a Stream Deck — so it ends with a manual verification step and the full check suite.

**Files:**
- Modify: `src/index.mjs`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `package.json`, `extension/package.json` (version bump)

**Interfaces:**
- Consumes: `applyAccentChoice` and `ACCENTS` from `src/accents.mjs` (Task 1); `openConfig(deps)` from `src/config-server.mjs` (Task 2); `renderBack({ width, height, glyph, caps })` from `src/render.mjs` (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the live-project set**

In `src/index.mjs`, add above `liveSessions()`:

```js
// Every folder with a live session: what the config page lists, and what the
// accent swap searches for the colour's current owner.
//
// Rebuilt in liveSessions() rather than in assignSlots, which runs only from
// refresh() — i.e. only on sessions-board polls. A config page left open while
// you toggle to the stats or detail board would otherwise be picking against a
// frozen set, and a project that appeared since would be invisible to the owner
// search, minting exactly the duplicate the swap exists to prevent.
//
// All live folders, not the visible 13: a project past the slot cap has no key
// yet but will, and it must not be invisible to that search. attentionQueue is
// passed the whole session list for the same reason.
const liveProjects = new Map();
```

and populate it inside `liveSessions()`, immediately after the `getLiveSessions` call:

```js
async function liveSessions() {
  const sessions = await getLiveSessions(allSources());
  liveProjects.clear();
  for (const s of sessions) {
    if (s.nested) continue;
    const key = folderKeyFor(s);
    // Same basename the key's caps bar shows — a project is named by its
    // window's folder, never by a session's cwd.
    if (!liveProjects.has(key)) {
      liveProjects.set(key, { name: s.folder.split("/").filter(Boolean).pop() ?? "", host: s.host ?? null });
    }
  }
  void publishSessions(sessions).catch(() => {});
  return sessions;
}
```

- [ ] **Step 2: Add the deps object**

In `src/index.mjs`, below `persistAccents()`:

```js
// The config server's entire coupling to the daemon. Two functions, so the
// page can be rewritten (drag-to-reorder, when it lands) without touching
// anything here, and so config-check can drive the real server with fakes.
const configDeps = {
  projects: () =>
    [...liveProjects]
      .map(([key, p]) => ({ key, name: p.name, host: p.host, accent: accentFor(key) }))
      // ?? Infinity, not a bare subtraction: assignSlots is what fills
      // folderOrder and it runs only on sessions-board polls, so a project
      // that appeared while the stats board was up has no position yet.
      // undefined - undefined is NaN, and a comparator returning NaN sorts
      // arbitrarily rather than failing.
      .sort((a, b) => (folderOrder.get(a.key) ?? Infinity) - (folderOrder.get(b.key) ?? Infinity)),
  setAccent: (folder, accent) => {
    applyAccentChoice(folderAccent, new Set(liveProjects.keys()), folder, accent);
    // Immediately rather than on the next poll, so a pick survives a daemon
    // killed a second later. The snapshot in persistAccents makes that poll's
    // own call a no-op.
    persistAccents();
  },
};
```

Add the import at the top, beside the other `./` imports:

```js
import { openConfig } from "./config-server.mjs";
```

- [ ] **Step 3: Add the tile and its index**

In `src/index.mjs`, beside `DETAIL_BACK_INDEX`:

```js
// Beside the back key on the bottom-left row, on the two stats-board buttons
// that the tile list never reaches. Assigned by index rather than spliced, for
// the same reason the back key is: an unreadable stats cache makes the list
// short, and the way in must not move.
export const CONFIG_INDEX = 11;
```

`refreshStats` needs almost nothing: it already signs the tile object wholesale
(`const drawn = \`stat ${JSON.stringify(stat)}\``) and spreads it into the
renderer (`render({ ...btn, ...stat, big: true })`), so a tile carrying `glyph`
and `caps` reaches `renderBack` with no new branch and is diffed for free.
Widen the one line that picks the renderer:

```js
// Two tiles in the list aren't stats: the back key and the config key, both
// assigned at fixed indices by the caller the way the detail board does it.
const render = stat.kind === "back" || stat.kind === "config" ? renderBack : renderStat;
```

In `run()`'s stats branch, beside `statTiles[DETAIL_BACK_INDEX] = { kind: "back" };`:

```js
statTiles[CONFIG_INDEX] = { kind: "config", glyph: "⚙", caps: "CONFIG" };
```

- [ ] **Step 4: Handle the press**

In `deck.on("down")`, in the `view.kind === "stats"` branch, replace the existing comment and body with:

```js
if (view.kind === "stats") {
  // Stat tiles aren't clickable; the back key and the config key are.
  if (control.index === DETAIL_BACK_INDEX) setView({ kind: "sessions" });
  if (control.index === CONFIG_INDEX) {
    // Back to the sessions board on the way out: the browser takes focus
    // anyway, and watching the accents change on the real keys is the only
    // place the choice actually reads.
    void openConfig(configDeps);
    setView({ kind: "sessions" });
  }
  lastPress = null;
  return;
}
```

- [ ] **Step 5: Amend the guard comments this change invalidates**

CLAUDE.md's rule: a guard that encodes "X is impossible" is deleted in the commit that makes X possible. Step 4 already did the first of these. The other two:

In `src/index.mjs`, `persistAccents`'s header comment, replace "Only on change, which in practice means the poll a new project first appears on" with:

```js
// Written from here rather than from assignSlots, which is exported and called
// by slots-check — a check that assigned an accent would write this machine's
// real file. The same reason keeps the config UI's swap pure and in
// accents.mjs: applyAccentChoice is exported and checked, this is neither.
// Only on change, which means the poll a new project first appears on, plus
// every manual pick from the config page.
```

In `src/index.mjs`'s collision comment inside `assignSlots`, append a sentence:

```js
// A manual pick cannot produce this state: applyAccentChoice trades with a
// live owner and deletes a closed one, so the duplicate never reaches the map.
// This is for two remembered claims that never saw each other.
```

- [ ] **Step 6: Run the whole check suite**

```bash
for c in render-check slots-check tasks-check usage-check stats-check title-check \
         subagents-check colors-check terminal-focus-check vscode-state-check \
         extension-check remote-install-check remote-check config-check; do
  printf "%-24s " "$c"; npm run --silent $c >/dev/null 2>&1 && echo OK || echo FAIL
done
```

Expected: all 14 OK. `terminal-focus-check` will FAIL until Step 8's version bump if you bump only one file — that is the check doing its job.

- [ ] **Step 7: Verify on the actual deck**

This task has no unit test; it needs the hardware.

1. `npm start`
2. Press the bottom-right usage key → the stats board appears. Confirm a `⚙ CONFIG` key at index 11, immediately right of the `← BACK` key on the bottom row.
3. Press it → the browser opens, and the deck returns to the sessions board.
4. The page lists every open project with its current accent as the bar colour.
5. Give a project a colour another open project is wearing. Within 2s, **both** keys change on the deck — they traded.
6. `cat ~/.claude/streamdeck-accents.json` — the new arrangement is there.
7. Ctrl-C, `npm start` again. The colours come back as you set them.
8. Reload the page → it still works (the token is stable for the daemon's life). Press the config key again → same URL, no second server.

- [ ] **Step 8: Bump both versions**

`package.json` and `extension/package.json` must stay equal — `terminal-focus-check` enforces it. Patch level:

```bash
npm version patch --no-git-tag-version
node -e 'const f="extension/package.json",j=JSON.parse(require("fs").readFileSync(f));j.version=require("./package.json").version;require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")'
npm run terminal-focus-check
```

Expected: PASS.

- [ ] **Step 9: Update the docs**

`CLAUDE.md`, commands block — add beside the other checks:

```
npm run config-check   # config server: token gate, validation, escaping
```

`CLAUDE.md`, module list — add after the `accents.mjs` entry:

```markdown
- `src/config-server.mjs` — the config page, served by the daemon on loopback
  and opened from the stats board's config key. Server-rendered HTML with form
  POSTs rather than a JSON API, decided on this repo's quality model rather
  than taste: a POST handler is checkable by a real server on port 0 and a real
  `fetch`, while client JS in a template literal is the one thing here nothing
  can lint, import or run. Its whole coupling to the daemon is a `deps` object
  of `projects()` and `setAccent()`, so the page renderer can be rewritten when
  drag-to-reorder needs real interactivity without touching `index.mjs` — and
  colour picking moves onto that same flow in the same pass, so the page never
  runs two paradigms. Loopback-bound with a per-server `randomUUID` checked
  *before* routing; the palette and the folder key are both validated against
  closed sets, because the folder key is another machine's string for a remote
  project. `esc()` is the full five-entity escape, not tags only — the hidden
  `folder` field is attribute context, where a `"` breaks out with no `<`
  involved, and a tag-only escaper passes a `<script>` test case while
  remaining injectable.
```

`CLAUDE.md`, extend the accents entry with the swap:

```markdown
  `applyAccentChoice` is the config UI's mutation, kept pure and kept here
  rather than beside `persistAccents`: that writes the real `~/.claude` file
  with no root argument, so an exported mutator that persisted would clobber
  this machine's accents with fixture folders on every check run. It trades
  with a *live* owner and **deletes** a closed one — handing a colour to
  something not on the board is invisible, and leaving the duplicate means the
  collision rule resolves that folder's return by `readdir` order, silently
  taking a deliberate choice back days later.
```

`CLAUDE.md`, under the read-only invariant, add:

```markdown
  The daemon also opens a **loopback TCP port**, but only after you press the
  config key — the one thing here that listens rather than reads. It still
  writes only its three files.
```

`README.md` — add after the accents paragraph:

```markdown
To change which colour a project wears, press the usage key for the stats
board, then the ⚙ CONFIG key. A page opens in your browser listing every open
project; pick one of the eight accents. If another open project already wears
it, the two swap, so no two projects on the board are ever the same colour.
The page is served by the daemon on localhost, only while it's running, and
only reachable with the token in the URL it just opened.
```

- [ ] **Step 10: Commit**

```bash
git add src/index.mjs CLAUDE.md README.md package.json extension/package.json
git commit -m "feat: open the config page from a key on the stats board"
```

---

## Self-review notes

Spec sections and the task that covers each:

| Spec section | Task |
|---|---|
| Palette is a closed set | 2 (validation), 1 (the array's home) |
| Collision resolved by swapping, incl. closed-owner delete | 1 |
| Server-rendered HTML with form POSTs | 2 |
| Server started by a press, kept for the daemon's life | 2 (`openConfig`), 4 (the press) |
| Token, loopback, `Referrer-Policy` | 2 |
| `accents.mjs` gains `ACCENTS` + `applyAccentChoice` | 1 |
| `config-server.mjs` | 2 |
| `renderBack` glyph/caps | 3 |
| The key at index 11, press returns to sessions | 4 |
| Routes and status codes | 2 |
| Request validation, 4KB cap | 2 |
| The page, `esc()` | 2 |
| `liveProjects` in `liveSessions()`, all live folders | 4 |
| `setAccent` wrapper | 4 |
| `config-check` | 2 |
| `slots-check` swap cases | 1 |
| `render-check` glyph case | 3 |
| Guard-comment sweep | 4 |
| Docs | 4 |
| Version bump | 4 |

Out of scope per the spec and deliberately absent from every task: drag-to-reorder, persisting `folderOrder`, listing closed projects, live-updating the page.
