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
         margin:0; padding:32px; box-sizing:border-box }
  /* Horizontally centred, vertically pinned to the top. Centring both ways
     looked better on one page and wrong across two: Accents and Time are
     different heights, so the heading and the tabs jumped every time you
     switched. A nav that moves when you use it is worse than empty space
     below the content. */
  main { width:100%; max-width:520px; margin:0 auto }
  h1 { font-size:15px; letter-spacing:.18em; text-transform:uppercase;
       color:#9e9e9e; font-weight:600; margin:0 0 24px }
  .row { margin:0 0 20px }
  /* The drop line. A box-shadow rather than a border so the row doesn't
     change height as it appears — a list that shifts under the pointer while
     you aim at it is the one thing a drop indicator must not do. */
  .row.above { box-shadow:0 -2px 0 #ffffff }
  .row.below { box-shadow:0 2px 0 #ffffff }
  .bar { display:flex; align-items:center; gap:8px; padding:6px 10px;
         border-radius:4px 4px 0 0; color:#000000bb; font-size:12px;
         font-weight:700; letter-spacing:.12em; text-transform:uppercase }
  /* Inside the bar, so it wears the project's own colour rather than sitting
     in the page's grey — dark on the accent like the caps beside it, since
     every accent is light by construction. letter-spacing is reset because the
     bar's tracking is for caps text and just pushes the glyph off centre. */
  .handle { cursor:grab; color:#00000088; font-size:15px; line-height:1;
            letter-spacing:0; user-select:none }
  .handle:active { cursor:grabbing }
  .key { background:#1b1b1b; padding:5px 10px; font-size:11px; color:#757575;
         font-family:ui-monospace,monospace; word-break:break-all }
  .swatches { display:flex; gap:6px; margin-top:8px }
  button { width:44px; height:28px; border:2px solid transparent; border-radius:4px;
           cursor:pointer; padding:0 }
  button.on { border-color:#ffffff }
  .empty, .hint { color:#757575 }
  .hint { font-size:12px; margin:-14px 0 24px }
  nav { margin:0 0 24px; font-size:12px }
  nav a { color:#4fc3f7; text-decoration:none; margin-right:16px }
  nav a.on { color:#e0e0e0; font-weight:700 }
  table { border-collapse:collapse; width:100%; font-size:13px }
  th { text-align:left; font-size:10px; letter-spacing:.14em; text-transform:uppercase;
       color:#757575; font-weight:600; padding:0 12px 8px 0 }
  td { padding:7px 12px 7px 0; border-top:1px solid #262626;
       font-variant-numeric:tabular-nums }
  td.project { font-weight:600 }
  /* The column the page exists for: time this project spent blocked on you.
     Applied per cell rather than per column, so an em dash for "none today"
     stays grey — colouring a zero draws the eye to the wrong row. */
  td.blocked { color:#ff8a65 }
  h2 { font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:#757575;
       font-weight:600; margin:28px 0 10px }
  /* Charts are divs whose width or height is a percentage, server-rendered
     like everything else on this page. No canvas, no chart library, nothing
     for the browser to compute — CLAUDE.md's rule about SCRIPT being the one
     part of this project no check can reach applies double to a drawing
     routine. */
  .chart { display:grid; grid-template-columns:44px 1fr 62px; gap:2px 8px;
           align-items:center; font-size:11px; font-variant-numeric:tabular-nums }
  /* Model ids are names, not clock times: haiku-4-5-20251001 ran straight out
     of the 44px column the hour charts share. No backticks in here — STYLE is
     a template literal, and one inside a comment ends it. */
  .chart.wide { grid-template-columns:132px 1fr 62px }
  .chart .t { color:#757575; text-align:right }
  .chart .v { color:#9e9e9e }
  .track { display:flex; height:11px; background:#1b1b1b; border-radius:2px; overflow:hidden }
  .track i { display:block; height:100% }
  /* An hour the daemon did not watch is not an idle hour, and must not draw as
     one. Diagonal stripes rather than an empty track: empty is a real reading
     here (nothing ran) and these two must never look alike. */
  .track.unseen { background:repeating-linear-gradient(135deg,#1b1b1b 0 4px,#242424 4px 8px) }
  .legend { display:flex; gap:14px; font-size:11px; color:#757575; margin:8px 0 0 }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:2px;
              margin-right:5px; vertical-align:-1px }
  /* Time series run left to right, so their bars stand up: one column per
     hour, height as a percentage of the busiest one. The horizontal .chart
     above stays for the by-model list, where the categories are names rather
     than a clock and reading them down the left is the whole point. */
  .cols { display:flex; align-items:flex-end; gap:2px; height:104px }
  .col { flex:1 1 0; display:flex; flex-direction:column-reverse; height:100%;
         background:#1b1b1b; border-radius:2px 2px 0 0; overflow:hidden }
  .col.unseen { background:repeating-linear-gradient(135deg,#1b1b1b 0 4px,#242424 4px 8px) }
  /* flex:none, or a column of segments would share the height out between them
     and every percentage above would be a suggestion. */
  .col i { display:block; width:100%; flex:none }
  /* Every hour gets a slot so the labels line up under their columns; only
     some of them carry text, because 25 timestamps in 460px is a smear. */
  .xaxis { display:flex; gap:2px; font-size:10px; color:#757575; margin-top:5px }
  .xaxis span { flex:1 1 0; text-align:center; white-space:nowrap }
  .peak { float:right; font-size:10px; color:#616161; letter-spacing:0;
          text-transform:none; font-weight:400 }
  /* The window picker. Links rather than a select, because a select needs a
     script to act on and this page decides everything on the server. */
  .periods { display:flex; gap:6px; margin:0 0 20px }
  .periods a { font-size:11px; color:#9e9e9e; text-decoration:none; padding:4px 10px;
               border-radius:4px; background:#1b1b1b }
  .periods a.on { background:#2a2a2a; color:#e0e0e0; font-weight:700 }`;

const nav = (token, here) =>
  `<nav>${[
    ["/", "Accents"],
    ["/activity", "Activity"],
  ]
    .map(([href, name]) =>
      href === here
        ? `<a class="on" href="${href}?t=${esc(token)}">${name}</a>`
        : `<a href="${href}?t=${esc(token)}">${name}</a>`
    )
    .join("")}</nav>`;

// Every number arrives formatted and every bar arrives as a percentage.
// index.mjs owns the summarising, the clock and the units; this file owns the
// markup, and keeping the split there is what lets config-check drive the page
// with fixed fixtures instead of reconstructing a day of history and a
// gigabyte of transcripts.
const STATE_FILL = {
  busy: "#43a047",
  shell: "#43a047",
  requires_action: "#e53935",
  waiting: "#c79100",
  idle: "#555555",
};

// One row per hour: label, a track, a value. `bars` is a list of
// {state, pct} so the same renderer draws a single-series chart (tokens) and a
// stacked one (sessions by state) — the difference is how many segments a row
// has, not a second code path.
const chart = (rows, wide = false) =>
  `<div class="chart${wide ? " wide" : ""}">${rows
    .map(
      (r) => `<span class="t">${esc(r.label)}</span>
      <span class="track${r.unseen ? " unseen" : ""}">${(r.bars ?? [])
        .map((b) => `<i style="width:${Number(b.pct) || 0}%;background:${STATE_FILL[b.state] ?? "#4fc3f7"}"></i>`)
        .join("")}</span>
      <span class="v">${esc(r.value)}</span>`
    )
    .join("")}</div>`;

// One column per hour, growing from the baseline, with the value in a `title`
// so hovering a column names it — 25 numbers will not fit under 25 columns and
// a tooltip needs no script.
const columns = ({ cols }) =>
  `<div class="cols">${cols
    .map(
      (c) => `<span class="col${c.unseen ? " unseen" : ""}" title="${esc(c.label)} · ${esc(c.value)}">${(c.bars ?? [])
        .map((b) => `<i style="height:${Number(b.pct) || 0}%;background:${STATE_FILL[b.state] ?? "#4fc3f7"}"></i>`)
        .join("")}</span>`
    )
    .join("")}</div>
  <div class="xaxis">${cols.map((c) => `<span>${esc(c.tick ?? "")}</span>`).join("")}</div>`;

const legend = (states) =>
  `<div class="legend">${states
    .map((s) => `<span><i style="background:${STATE_FILL[s] ?? "#4fc3f7"}"></i>${esc(s.replace("requires_action", "blocked"))}</span>`)
    .join("")}</div>`;

const periodBar = (token, periods, here) =>
  `<div class="periods">${periods
    .map(
      (p) =>
        `<a${p.key === here ? ' class="on"' : ""} href="/activity?t=${esc(token)}&amp;p=${esc(p.key)}">${esc(p.name)}</a>`
    )
    .join("")}</div>`;

function activityPage(token, { period, periods, rows, tokens, sessions, models }) {
  const table = (period) => `
    <table>
      <tr><th>Project</th><th>Busy</th><th>Waiting</th><th>Blocked on you</th></tr>
      ${rows
        .map(
          (r) => `<tr>
        <td class="project">${esc(r.name)}</td>
        <td>${esc(r[period].busy)}</td>
        <td>${esc(r[period].waiting)}</td>
        <td${r[period].blocked === "—" ? "" : ' class="blocked"'}>${esc(r[period].blocked)}</td>
      </tr>`
        )
        .join("")}
    </table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>streamdeck config</title>
    <style>${STYLE}</style></head><body>
    <main>
      <h1>Activity</h1>
      ${nav(token, "/activity")}
      ${periodBar(token, periods, period)}
      ${
        tokens.cols.length === 0
          ? ""
          : `<h2>Output tokens<span class="peak">peak ${esc(tokens.peak)}</span></h2>${columns(tokens)}`
      }
      ${
        models.length === 0
          ? ""
          : `<h2>By model</h2>${chart(models, true)}`
      }
      ${
        sessions.cols.length === 0
          ? ""
          : `<h2>Sessions in parallel<span class="peak">${esc(sessions.peak)}</span></h2>${columns(sessions)}${legend(["busy", "requires_action", "waiting", "idle"])}`
      }
      ${
        rows.length === 0
          ? '<p class="empty">no history recorded yet</p>'
          : `<h2>Where the time went · today</h2>${table("today")}<h2>Last 7 days</h2>${table("week")}`
      }
    </main>
    </body></html>`;
}

function page(token, projects) {
  const rows = projects
    .map(
      (p) => `
    <form class="row" data-key="${esc(p.key)}" method="post" action="/accent?t=${esc(token)}">
      <input type="hidden" name="folder" value="${esc(p.key)}">
      <div class="bar" style="background:${esc(p.accent)}">
        <span class="handle" draggable="true" title="drag to reorder">⠿</span>
        <span>${esc(p.name)}</span>
      </div>
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
    <main>
      <h1>Projects</h1>
      ${nav(token, "/")}
      <p class="hint">Topmost is the first block on the deck. Drag a handle to reorder.</p>
      ${rows || '<p class="empty">nothing on the board right now</p>'}
    </main>
    <script>${SCRIPT}</script>
    </body></html>`;
}

// The one piece of this project nothing can check: no lint, no import, no test
// script can reach it. That was the known and accepted price of drag — the
// spec says so — and it is why everything that can be decided on the server is
// decided there. What lives here is the parts a browser has to do: which row
// the pointer is over, and which side of its midpoint.
//
// Every listener is delegated from `document`, because a mutation replaces
// document.body wholesale — bind to a row and the page stops responding after
// the first change.
//
// A mutation POSTs and then renders whatever comes back. The 303 those POSTs
// answer with is followed by fetch on its own, so the response body *is* the
// re-rendered page: one renderer, on the server, for both interactions. That
// is what keeps a drag and a colour pick behaving identically instead of the
// page running two paradigms. The form is left a real form, so with JS off
// colour picking still works exactly as it did before drag existed.
const SCRIPT = `
const rows = () => [...document.querySelectorAll(".row")];
const clear = () => rows().forEach((r) => r.classList.remove("above", "below"));
let dragged = null;

async function send(path, params) {
  const res = await fetch(path + location.search, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const html = await res.text();
  // replaceChildren over innerHTML: the source is this server's own output,
  // already escaped by esc(), but parsing once and moving nodes keeps the
  // string out of an HTML sink entirely. Scripts don't execute either way,
  // which is why every listener here is delegated from document.
  const fresh = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceChildren(...fresh.body.childNodes);
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  // e.submitter, not FormData: new FormData(form) omits the button that
  // submitted it, and the swatch's value is the whole point of the click.
  send("/accent", { folder: e.target.dataset.key, accent: e.submitter.value });
});

document.addEventListener("dragstart", (e) => {
  if (!e.target.classList?.contains("handle")) return;
  dragged = e.target.closest(".row");
  e.dataTransfer.effectAllowed = "move";
  // Some data has to be set or Safari refuses to start the drag at all.
  e.dataTransfer.setData("text/plain", dragged.dataset.key);
  e.dataTransfer.setDragImage(dragged, 12, 12);
});

document.addEventListener("dragover", (e) => {
  if (!dragged) return;
  e.preventDefault();
  clear();
  const row = e.target.closest?.(".row");
  if (row && row !== dragged) {
    const box = row.getBoundingClientRect();
    row.classList.add(e.clientY < box.top + box.height / 2 ? "above" : "below");
    return;
  }
  // Nothing under the pointer: dragging into the empty space below the list is
  // the natural way to ask for "last", and doing nothing there made the one
  // gesture people reach for feel broken.
  if (row) return;
  const last = rows().at(-1);
  if (last && last !== dragged && e.clientY > last.getBoundingClientRect().bottom) {
    last.classList.add("below");
  }
});

document.addEventListener("drop", (e) => {
  if (!dragged) return;
  e.preventDefault();
  const target = rows().find((r) => r.classList.contains("above") || r.classList.contains("below"));
  const from = dragged;
  // Read the side *before* clearing. This was the bug: clear() strips the very
  // class the side is read from, so every drop resolved as "above" and a drop
  // below the last row landed second-to-last.
  const side = target?.classList.contains("below") ? "below" : "above";
  clear();
  dragged = null;
  if (!target) return;
  // What was under the pointer and which half of it, nothing more. Working out
  // the resulting position is the server's job, where a check can see it.
  send("/order", { folder: from.dataset.key, target: target.dataset.key, side });
});

document.addEventListener("dragend", () => {
  dragged = null;
  clear();
});
`;

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

// Resolves to the body, or to null if it went over MAX_BODY.
//
// Over the cap it stops accumulating and drains the rest rather than calling
// req.destroy(): killing the socket reaches the browser as a network error
// rather than as the refusal it is, and the response still has to arrive.
// Memory is bounded either way — the discarded chunks are never appended.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        body = "";
      }
    });
    req.on("end", () => resolve(tooBig ? null : body));
    req.on("error", reject);
  });
}

/**
 * A listening server and the URL that opens it. Does not touch a browser.
 *
 * Loopback-bound, so nothing off this machine can reach it whatever else is
 * true, and gated on a per-server randomUUID, so no other local process — and
 * no page you happen to have open — can POST to it either. Compared with `!==`
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
      // Checked before routing, so an unknown path without a token doesn't
      // confirm that the path is unknown.
      if (url.searchParams.get("t") !== token) return send(res, 403, "forbidden");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, page(token, deps.projects()), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/activity") {
        // The window is a hint, not a command: index.mjs falls back to its
        // default for anything it doesn't recognise and echoes back which one
        // it actually used, so an edited URL can't render a page whose picker
        // disagrees with its charts.
        return send(res, 200, activityPage(token, deps.activity(url.searchParams.get("p"))), "text/html; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/accent") {
        const raw = await readBody(req);
        if (raw === null) return send(res, 400, "body too large");
        const form = new URLSearchParams(raw);
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
        // A 400 above is a dead end by contrast — only a stale page or a
        // forged request gets one, and the way back for both is the config key.
        res.writeHead(303, { Location: `/?t=${token}` });
        return res.end();
      }

      if (req.method === "POST" && url.pathname === "/order") {
        const raw = await readBody(req);
        if (raw === null) return send(res, 400, "body too large");
        const form = new URLSearchParams(raw);
        const folder = form.get("folder");
        // What the pointer was over, and which side of its midpoint — not the
        // resulting position. Turning those into an anchor is index
        // arithmetic, and it lived in the browser until a drop below the last
        // row put a project second-to-last instead: the client read the side
        // off a class it had already cleared, so every drop resolved as
        // "above". Here it is covered by config-check, which is the whole
        // reason for the split — the client reports what it saw, the server
        // decides what it means.
        const target = form.get("target");
        const side = form.get("side");
        const live = deps.projects().map((p) => p.key);
        if (!live.includes(folder)) return send(res, 400, "unknown project");
        // The anchor is validated for a sharper reason than the folder:
        // moveProject reads a key it can't find as "put it last", so a stale
        // one would quietly send a project to the bottom of the board rather
        // than erroring, and you would blame the drag.
        if (!live.includes(target)) return send(res, 400, "unknown anchor");
        if (side !== "above" && side !== "below") return send(res, 400, "unknown side");
        if (target !== folder) {
          // The dragged project is removed first: it is about to move, so it
          // can never be its own anchor, and leaving it in shifts every index
          // past it by one. Running off the end is the "drop it last" case,
          // which is null rather than an error.
          const rest = live.filter((key) => key !== folder);
          const at = rest.indexOf(target) + (side === "below" ? 1 : 0);
          deps.reorder(folder, rest[at] ?? null);
        }
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
    // Best-effort like every other risky path here: the deck is untouched
    // either way, and a next press retries from scratch.
    running = null;
    console.error("config server failed:", err?.message ?? err);
  }
}
