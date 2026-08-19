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
import { networkInterfaces } from "node:os";
import { ACCENTS } from "./accents.mjs";
import { DEFAULT_PORT, readBoardState, writeBoardState } from "./board-state.mjs";
import { boardGrid, boardPage, detailPanel, iconHeader, HEADER_CSS } from "./board-page.mjs";
import { renderIcon, usageColor } from "./render.mjs";
import { esc, colour } from "./html.mjs";

// A form POST of one folder key and one hex value. Anything approaching this
// is not a browser filling in the page we served.
const MAX_BODY = 4096;

const STYLE = `
  :root { color-scheme: dark }
  :root { --page-bg:#121212 }
  /* No padding on the body: the header is sticky and full-bleed, and a padded
     body would leave a strip of page showing above it as you scroll. */
  body { background:#121212; color:#e0e0e0; font-family:-apple-system,sans-serif;
         margin:0; padding:0; box-sizing:border-box }
  /* border-box, or max-width plus this padding is wider than the window it is
     capped to and the page scrolls sideways. */
  main { padding:28px calc(clamp(12px,2.2vw,32px) + var(--safe-right)) calc(48px + var(--safe-bottom))
                calc(clamp(12px,2.2vw,32px) + var(--safe-left)); box-sizing:border-box }
  /* Horizontally centred, vertically pinned to the top. Centring both ways
     looked better on one page and wrong across two: Accents and Time are
     different heights, so the heading and the tabs jumped every time you
     switched. A nav that moves when you use it is worse than empty space
     below the content. */
  main { width:100%; max-width:520px; margin:0 auto }
  /* The activity page carries charts and a table beside a pie; 520px is right
     for a list of projects and cramped for those. */
  main.wide { max-width:1180px }
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
  .hint { font-size:13px; margin:0 0 24px }
  table { border-collapse:collapse; width:100%; font-size:17px }
  th { text-align:left; font-size:12px; letter-spacing:.14em; text-transform:uppercase;
       color:#757575; font-weight:600; padding:0 16px 10px 0 }
  td { padding:11px 16px 11px 0; border-top:1px solid #262626;
       font-variant-numeric:tabular-nums }
  td.project { font-weight:600 }
  /* The column the page exists for: time this project spent blocked on you.
     Applied per cell rather than per column, so an em dash for "none today"
     stays grey — colouring a zero draws the eye to the wrong row. */
  td.blocked { color:#ff8a65 }
  h2 { font-size:13px; letter-spacing:.16em; text-transform:uppercase; color:#757575;
       font-weight:600; margin:34px 0 12px }
  /* Charts are divs whose width or height is a percentage, server-rendered
     like everything else on this page. No canvas, no chart library, nothing
     for the browser to compute — CLAUDE.md's rule about SCRIPT being the one
     part of this project no check can reach applies double to a drawing
     routine. */
  .chart { display:grid; grid-template-columns:54px 1fr 78px; gap:3px 10px;
           align-items:center; font-size:13px; font-variant-numeric:tabular-nums }
  /* Model ids are names, not clock times: haiku-4-5-20251001 ran straight out
     of the 44px column the hour charts share. No backticks in here — STYLE is
     a template literal, and one inside a comment ends it. */
  .chart.wide { grid-template-columns:172px 1fr 78px }
  .chart .t { color:#757575; text-align:right }
  .chart .v { color:#9e9e9e }
  .track { display:flex; height:15px; background:#1b1b1b; border-radius:2px; overflow:hidden }
  .track i { display:block; height:100% }
  /* An hour the daemon did not watch is not an idle hour, and must not draw as
     one. Diagonal stripes rather than an empty track: empty is a real reading
     here (nothing ran) and these two must never look alike. */
  .track.unseen { background:repeating-linear-gradient(135deg,#1b1b1b 0 4px,#242424 4px 8px) }
  .legend { display:flex; gap:18px; font-size:13px; color:#757575; margin:10px 0 0 }
  .legend i { display:inline-block; width:11px; height:11px; border-radius:2px;
              margin-right:6px; vertical-align:-1px }
  /* Money, not tokens — its own line rather than another number crowding the
     heading, and in the metered rung's own amber. */
  .cost { font-size:14px; color:#ffb300; margin:12px 0 0 }
  /* Time series run left to right, so their bars stand up: one column per
     hour, height as a percentage of the busiest one. The horizontal .chart
     above stays for the by-model list, where the categories are names rather
     than a clock and reading them down the left is the whole point. */
  .cols { display:flex; align-items:flex-end; gap:3px; height:170px }
  .col { flex:1 1 0; display:flex; flex-direction:column-reverse; height:100%;
         background:#1b1b1b; border-radius:2px 2px 0 0; overflow:hidden }
  .col.unseen { background:repeating-linear-gradient(135deg,#1b1b1b 0 4px,#242424 4px 8px) }
  /* flex:none, or a column of segments would share the height out between them
     and every percentage above would be a suggestion. */
  .col i { display:block; width:100%; flex:none }
  /* Every hour gets a slot so the labels line up under their columns; only
     some of them carry text, because 25 timestamps in 460px is a smear. */
  .xaxis { display:flex; gap:3px; font-size:12px; color:#757575; margin-top:6px }
  .xaxis span { flex:1 1 0; text-align:center; white-space:nowrap }
  .peak { float:right; font-size:12px; color:#616161; letter-spacing:0;
          text-transform:none; font-weight:400 }
  /* The window picker. Links rather than a select, because a select needs a
     script to act on and this page decides everything on the server. */
  .periods { display:flex; gap:6px; margin:0 0 20px }
  .periods a { font-size:14px; color:#9e9e9e; text-decoration:none; padding:8px 15px;
               border-radius:5px; background:#1b1b1b }
  .periods a.on { background:#2a2a2a; color:#e0e0e0; font-weight:700 }
  /* Table left, pie right, wrapping under on a narrow window rather than
     squeezing the columns. */
  .split { display:flex; gap:28px; align-items:flex-start; flex-wrap:wrap }
  .split table { flex:1 1 460px }
  /* A conic-gradient, not an SVG: the slices are already percentages by the
     time they get here, so there is no trig and no path to build. */
  .pie { flex:none; width:240px; border-radius:50%; aspect-ratio:1 }
  .pie-total { flex:none; width:240px; text-align:center; font-size:13px;
               color:#757575; margin-top:10px }
  /* Ties a row to its slice, so the pie needs no legend. */
  .dot { display:inline-block; width:11px; height:11px; border-radius:2px;
         margin-right:9px; vertical-align:-1px }
  /* The rate-limit meters and the all-time totals, which moved here off a page
     of their own. Side by side where there is room, stacked on a phone. */
  h2.first { margin-top:6px }
  .limits { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)) }
  .limit { background:#1b1b1b; border-radius:8px; padding:16px 18px }
  .lrow { display:flex; align-items:baseline; gap:12px }
  .lcap { flex:1; font-size:11px; letter-spacing:.14em; text-transform:uppercase;
          color:#9e9e9e; font-weight:700 }
  .lpct { font-size:30px; font-weight:700; color:#fff; line-height:1;
          font-variant-numeric:tabular-nums }
  .ltrack { height:8px; border-radius:4px; background:#ffffff1a; overflow:hidden; margin:12px 0 8px }
  .ltrack i { display:block; height:100% }
  /* The half a key has no room for: a percentage means one thing twenty
     minutes before its window turns over and another on day one of seven. */
  .lsub { font-size:12px; color:#757575 }
  /* A grid rather than the seven stacked rows these were on their own page:
     they sit above the charts now, and a column of them would push the thing
     you came for below the fold.
     Each one its own card, like the meters above — separating them with the
     container's colour showing through 1px gaps left the *unfilled* end of the
     last row as one lighter block, which reads as a missing tile. */
  .facts { display:grid; gap:10px; margin:14px 0 0;
           grid-template-columns:repeat(auto-fit,minmax(190px,1fr)) }
  .fact { background:#1b1b1b; border-radius:8px; padding:12px 16px;
          display:flex; flex-direction:column; gap:4px }
  .fl { font-size:11px; color:#757575 }
  .fv { font-size:17px; font-weight:600; color:#fff; font-variant-numeric:tabular-nums }
  .ver { margin:36px 0 0; text-align:center; font-size:12px; color:#616161 }`;

// Every number arrives formatted and every bar arrives as a percentage.
// index.mjs owns the summarising, the clock and the units; this file owns the
// markup, and keeping the split there is what lets config-check drive the page
// with fixed fixtures instead of reconstructing a day of history and a
// gigabyte of transcripts.
const STATE_FILL = {
  // The two meters, told apart by hue rather than by a label under every
  // column: Claude keeps the page's own blue, Codex the vendor's green.
  claude: "#4fc3f7",
  codex: "#66bb6a",
  // Amber, and deliberately not another cool hue: this is the rung that costs
  // money per run, and it should not blend into the two that are prepaid.
  "codex-api": "#ffb300",
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

// The two rate-limit windows, as meters. The deck has to spend two whole keys
// saying "Session reset 3h" and "Week reset 5d", because a 72px key cannot
// hold a percentage and the window it is a percentage *of* at once — and 81%
// twenty minutes before a reset means something quite different from 81% on
// day one of seven. Here each window is one meter with its own reset under it.
const limits = (usage) =>
  `<div class="limits">${[
    ["Session · 5 hours", usage.session, usage.sessionResets],
    ["Week · 7 days", usage.week, usage.weekResets],
  ]
    .map(
      ([caps, pct, resets]) => `<div class="limit">
        <div class="lrow"><span class="lcap">${esc(caps)}</span>
          <span class="lpct">${typeof pct === "number" ? Math.round(pct) + "%" : "—"}</span></div>
        <div class="ltrack"><i style="width:${
          typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 0
        }%;background:${usageColor(pct ?? 0)}"></i></div>
        <div class="lsub">${resets ? `resets in ${esc(resets)}` : "reset time unknown"}</div>
      </div>`
    )
    .join("")}</div>`;

// Today's blocked time and the all-time totals, as a grid that reflows rather
// than the seven-row list they were on a page of their own — they sit above
// the charts now, and nine stacked rows would push the thing you came for
// below the fold.
const facts = (blocked, stats) =>
  `<div class="facts">${[{ label: "Blocked on you today", value: blocked }, ...stats]
    .map((t) => `<div class="fact"><span class="fl">${esc(t.label)}</span><span class="fv">${esc(t.value)}</span></div>`)
    .join("")}</div>`;

function activityPage(token, { period, periods, rows, pie, tokens, sessions, models }, status) {
  const table = () => `
    <table>
      <tr><th>Project</th><th>Busy</th><th>Waiting</th><th>Blocked on you</th><th>Total</th></tr>
      ${rows
        .map(
          (r) => `<tr>
        <td class="project"><i class="dot" style="background:${colour(r.accent)}"></i>${esc(r.name)}</td>
        <td>${esc(r.busy)}</td>
        <td>${esc(r.waiting)}</td>
        <td${r.blocked === "—" ? "" : ' class="blocked"'}>${esc(r.blocked)}</td>
        <td>${esc(r.total)}</td>
      </tr>`
        )
        .join("")}
    </table>`;

  // Stops arrive cumulative, so this is a join rather than a running total —
  // see the comment where they are computed.
  const wheel = () =>
    `<div class="pie" style="background:conic-gradient(${pie.slices
      .map((s) => `${colour(s.accent)} ${Number(s.from) || 0}% ${Number(s.to) || 0}%`)
      .join(",")})"></div>
     <div class="pie-total">${esc(pie.total)} of session time</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>streamdeck config</title>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <style>${HEADER_CSS}${STYLE}</style></head><body>
    ${iconHeader(token, "activity", "Activity")}
    <main class="wide">
      <h2 class="first">Rate limits</h2>
      ${limits(status.usage)}
      ${facts(status.blocked, status.stats)}
      <h2>Where the tokens went</h2>
      ${periodBar(token, periods, period)}
      ${
        tokens.cols.length === 0
          ? ""
          : `<h2>Output tokens<span class="peak">peak ${esc(tokens.peak)}</span></h2>${columns(tokens)}${
              tokens.providers.length > 1 ? legend(tokens.providers) : ""
            }${tokens.cost ? `<p class="cost">${esc(tokens.cost)}</p>` : ""}`
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
          : `<h2>Where the time went</h2><div class="split">${table()}<div>${wheel()}</div></div>`
      }
      <p class="ver">Claude Deck v${esc(status.version)}</p>
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
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <style>${HEADER_CSS}${STYLE}</style></head><body>
    ${iconHeader(token, "accents", "Projects")}
    <main>
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
const icons = {};

export async function createConfigServer(deps, host = "127.0.0.1", { port: wanted, remember = false } = {}) {
  // Reuse the address this daemon last answered on, so a page already open on
  // an iPad reconnects by itself after a restart instead of sitting grey until
  // someone scans a new code. A first run mints both.
  const remembered = remember ? readBoardState() : { port: null, token: null };
  const token = remembered.token ?? randomUUID();

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

      // The two things that turn a saved bookmark into a home-screen app: a
      // manifest (Android reads it; iOS reads the meta tags in the page) and
      // PNG icons. Both sit behind the same token gate as everything else,
      // and both are linked with the token in their href — the manifest has
      // to be, because `start_url` carries the token that makes the installed
      // app open a board rather than a 403.
      if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
        return send(
          res,
          200,
          JSON.stringify({
            name: "Claude Deck",
            // Identical to the page's apple-mobile-web-app-title: this is the
            // name under the icon, and the same app must not be called two
            // things depending on which phone it landed on.
            short_name: "Claude Deck",
            start_url: `/board?t=${token}`,
            display: "standalone",
            orientation: "any",
            background_color: "#0b0b0b",
            theme_color: "#0b0b0b",
            icons: [192, 512].map((s) => ({
              src: `/icon-${s}.png?t=${token}`,
              sizes: `${s}x${s}`,
              type: "image/png",
              purpose: "any",
            })),
          }),
          "application/manifest+json; charset=utf-8"
        );
      }

      const icon = url.pathname.match(/^\/icon-(180|192|512)\.png$/);
      if (req.method === "GET" && icon) {
        // Rendered once per size and held: it is three kilobytes and never
        // changes, and a home screen asks for it exactly when the network is
        // least interesting.
        const size = Number(icon[1]);
        icons[size] ??= await renderIcon(size);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        return res.end(icons[size]);
      }

      // The board, and the fragment its own 2s poll re-fetches. Both come
      // from one `deps.board()` call, so the page you load and the tiles that
      // replace it can never be rendered by two different code paths.
      if (req.method === "GET" && url.pathname === "/board") {
        return send(res, 200, boardPage(token, await deps.board()), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/board/grid") {
        // Deliberately a fragment rather than a JSON payload the client turns
        // into markup: one renderer, on the server, for the first paint and
        // every one after it.
        return send(res, 200, boardGrid((await deps.board()).keys, token), "text/html; charset=utf-8");
      }

      // One session at length, for the panel a second tap opens. `deps.detail`
      // answers null for an id it doesn't know — which is both "you made that
      // up" and "it ended while you were looking at it", and the panel says
      // the same thing either way rather than this handler guessing which.
      if (req.method === "GET" && url.pathname === "/session") {
        return send(res, 200, detailPanel(await deps.detail(url.searchParams.get("id"))), "text/html; charset=utf-8");
      }

      // A tap on a session tile. The same focusWindow a deck press calls, and
      // the id is checked against the live board rather than trusted: it
      // arrives from a device on the LAN, and everything downstream of it
      // reaches VS Code and a shell.
      if (req.method === "POST" && url.pathname === "/focus") {
        const raw = await readBody(req);
        if (raw === null) return send(res, 400, "body too large");
        const id = new URLSearchParams(raw).get("session");
        const keys = (await deps.board()).keys;
        if (!keys.some((k) => k.kind === "session" && k.id === id)) return send(res, 400, "unknown session");
        deps.focus(id);
        // No redirect: the page stays where it is and picks the result up on
        // its next poll, like every other thing it shows.
        res.writeHead(204);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/activity") {
        // The window is a hint, not a command: index.mjs falls back to its
        // default for anything it doesn't recognise and echoes back which one
        // it actually used, so an edited URL can't render a page whose picker
        // disagrees with its charts.
        // Two formatters, one page: `status` is the rate-limit windows and the
        // all-time totals, which no window picker applies to, and `activity`
        // is everything the picker governs. Kept apart in index.mjs because
        // they are cached on completely different clocks.
        return send(
          res,
          200,
          activityPage(token, deps.activity(url.searchParams.get("p")), await deps.status()),
          "text/html; charset=utf-8"
        );
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
        // The board posts this from its settings sheet and stays put — it has
        // no page to be redirected to, and its keys pick the new accent up on
        // the next poll. The config page's own form still wants the 303.
        if (url.searchParams.get("from") === "board") {
          res.writeHead(204);
          return res.end();
        }
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

  // The port we would like, then whatever we can get. A fixed port is the
  // whole point — but something else holding it must not stop the board
  // coming up, so this degrades to an ephemeral one and says so. `warning` is
  // returned rather than logged here: this module has no console of its own by
  // design, and run() is where the QR is printed anyway.
  // Ephemeral unless someone asked for an address worth remembering. A check
  // spins up a real server on this machine, and a fixed default would have it
  // fighting the daemon that is actually running for the same socket.
  const first = wanted ?? remembered.port ?? (remember ? DEFAULT_PORT : 0);
  let warning = null;
  try {
    await listenOn(server, first, host);
  } catch (err) {
    if (err?.code !== "EADDRINUSE" && err?.code !== "EACCES") throw err;
    await listenOn(server, 0, host);
    warning = `port ${first} is in use — the board is on ${server.address().port} this run, so an old bookmark or QR will not reach it`;
  }
  const port = server.address().port;
  // The port to *try* next time, not the one we ended up on. Those differ
  // exactly when something else held it, and remembering the ephemeral
  // fallback would chase a number that means nothing — the squatter is the
  // thing that goes away, and the next run should ask for the standard port
  // again and get it.
  if (remember) writeBoardState({ port: first, token });
  return { server, port, token, warning, url: `http://127.0.0.1:${port}/?t=${token}` };
}

// listen() reports failure by event, not by rejection, and the error listener
// has to come off again or the second attempt inherits it.
function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      server.removeListener("listening", ok);
      reject(err);
    };
    const ok = () => {
      server.removeListener("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ok);
    server.listen(port, host);
  });
}

/**
 * This machine's first non-internal IPv4 address, or null. What the iPad has
 * to dial, and the one thing about the board that can't be derived from the
 * server itself.
 *
 * First rather than best: a laptop has one Wi-Fi address and a pile of virtual
 * ones (Docker, VPNs, `awdl0`), and picking correctly between those needs a
 * routing table. The QR is printed with whatever this returns, so a wrong
 * guess is visible immediately and fixed by reading the address off the line
 * beside it — which is why it prints the URL as text too.
 */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

// One server for both doors into it — the config key and the board — kept for
// the daemon's life: an idle shutdown is a timer to get wrong. The *promise*
// is memoised, not its result, so two fast presses can't start two servers,
// and whichever door opens first decides the bind address.
let running = null;

/**
 * The server, started if it isn't. `host` is honoured only by the call that
 * actually starts it: the daemon starts it on 0.0.0.0 so an iPad can reach the
 * board, and a config-key press on a daemon that skipped that (STREAMDECK_NO_BOARD)
 * starts it on loopback instead.
 */
export function startServer(deps, host, opts) {
  running ??= createConfigServer(deps, host, opts);
  return running;
}

export async function openConfig(deps) {
  try {
    const { url } = await startServer(deps);
    console.log(`config: ${url}`);
    execFile("open", [url], () => {});
  } catch (err) {
    // Best-effort like every other risky path here: the deck is untouched
    // either way, and a next press retries from scratch.
    running = null;
    console.error("config server failed:", err?.message ?? err);
  }
}
