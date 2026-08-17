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
         margin:0; padding:32px }
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
