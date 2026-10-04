// The tmux cleanup page: server-rendered, one form per host. The browser only
// reports which boxes were ticked (tmux-cleanup.mjs decides what that means),
// and the one script here ticks groups and asks before submitting.
import { esc } from "./html.mjs";
import { HEADER_CSS, iconHeader, iconLinks } from "./board-page.mjs";

const idle = (s) => (s < 90 ? "now" : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`);

const STYLE = `
  body { margin: 0; background: #0b0b0b; color: #e0e0e0; font: 14px/1.45 -apple-system, system-ui, sans-serif }
  main { max-width: 980px; margin-inline: auto; padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px)) }
  h2 { font-size: 16px; margin: 22px 0 8px }
  h2 small { color: #9e9e9e; font-weight: 400; margin-left: 10px }
  .sub, .note { color: #9e9e9e; font-size: 13px }
  .banner { background: #14301a; color: #a5d6a7; border-radius: 6px; padding: 8px 12px; margin-top: 14px }
  .banner.warn { background: #3a2f00; color: #ffc107 }
  .group { background: #151515; border: 1px solid #262626; border-radius: 8px; margin: 0 0 14px; overflow: hidden }
  .ghead { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #262626 }
  .ghead h3 { font-size: 14px; margin: 0 }
  .ghead p { margin: 0; color: #9e9e9e; font-size: 13px; flex: 1 1 260px; min-width: 0 }
  .ghead label { color: #64b5f6; cursor: pointer; font-size: 13px }
  .row { display: grid; grid-template-columns: 28px 70px minmax(0, 1.2fr) minmax(0, 2fr) 70px; gap: 4px 12px; align-items: center; padding: 9px 14px; border-top: 1px solid #262626 }
  .group .row:first-of-type { border-top: 0 }
  .row.off { opacity: .55 }
  .row input { width: 16px; height: 16px; accent-color: #64b5f6 }
  .tm { font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums }
  .proj { font-weight: 600; min-width: 0 }
  .proj small { display: block; font-weight: 400; color: #9e9e9e; overflow-wrap: anywhere }
  .why { color: #9e9e9e; font-size: 13px; min-width: 0 }
  .age { text-align: right; color: #9e9e9e; font-variant-numeric: tabular-nums }
  .bar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; margin-top: 10px }
  .bar .msg { flex: 1 1 240px; color: #9e9e9e }
  .bar button { font: inherit; color: #ffd5d5; background: #5b1f1f; border: 0; border-radius: 5px; padding: 8px 14px; cursor: pointer }
  .bar button:disabled { background: #262626; color: #9e9e9e; cursor: default }
  @media (max-width: 640px) { .row { grid-template-columns: 24px 56px minmax(0, 1fr) } .why, .age { grid-column: 3; text-align: left } }`;

const SCRIPT = `
  for (const form of document.querySelectorAll("form.host")) {
    const boxes = () => [...form.querySelectorAll("input[name=name]")];
    const paint = () => {
      const n = boxes().filter((b) => b.checked).length;
      form.querySelector("button").disabled = !n;
      form.querySelector(".msg").textContent = n ? n + " selected" : "Nothing selected.";
    };
    form.addEventListener("change", (e) => {
      if (e.target.dataset.all) for (const b of form.querySelectorAll("input[name=name][data-g=" + e.target.dataset.all + "]")) b.checked = e.target.checked;
      paint();
    });
    form.addEventListener("submit", (e) => {
      const n = boxes().filter((b) => b.checked).length;
      if (!confirm("End " + n + " tmux session" + (n === 1 ? "" : "s") + " on " + form.dataset.host + "? Their conversations stay on disk.")) e.preventDefault();
    });
    paint();
  }`;

const GROUPS = [
  { kind: "copy", title: "Hidden copies", blurb: "The same Claude session is also open in a newer window. The board follows the newer one, so these never show up. Two copies writing to one conversation can also mix up its history.", on: true },
  { kind: "other", title: "Not Claude", blurb: "Plain shells and tools left in tmux. Nothing here for the board to show. Not ticked by default.", on: false },
  { kind: "use", title: "In use", blurb: "Showing on the board, or the only copy of its session. Can't be selected here." },
];

function hostSection(token, { host, rows, error }) {
  if (error || !rows) return `<h2>${esc(host)}<small>not answering</small></h2><p class="sub">Couldn't list tmux sessions. Nothing was changed.</p>`;
  const claude = rows.filter((r) => r.kind !== "other").length;
  const group = (g) => {
    const mine = rows.filter((r) => r.kind === g.kind);
    if (!mine.length) return "";
    const line = (r) => `<div class="row${g.kind === "use" ? " off" : ""}">
      ${g.kind === "use" ? "<span></span>" : `<input type="checkbox" name="name" value="${esc(r.name)}" data-g="${g.kind}"${g.on ? " checked" : ""} aria-label="select tmux ${esc(r.name)}">`}
      <span class="tm">tmux ${esc(r.name)}</span>
      <span class="proj">${esc(r.project)}<small>${esc(r.title)}</small></span>
      <span class="why">${esc(r.why)}</span>
      <span class="age">${esc(idle(r.idle))}</span></div>`;
    return `<section class="group"><div class="ghead"><h3>${esc(g.title)} (${mine.length})</h3><p>${esc(g.blurb)}</p>${
      g.kind === "use" ? "" : `<label><input type="checkbox" data-all="${g.kind}"${g.on ? " checked" : ""}> select all</label>`
    }</div>${mine.map(line).join("")}</section>`;
  };
  return `<h2>${esc(host)}<small>${rows.length} tmux sessions, ${claude} running Claude</small></h2>
    <form class="host" method="post" action="/tmux/close?t=${esc(token)}" data-host="${esc(host)}">
      <input type="hidden" name="host" value="${esc(host)}">
      ${GROUPS.map(group).join("")}
      <div class="bar"><span class="msg"></span><button type="submit">Close selected</button></div>
    </form>`;
}

/** `done` is `{ closed, skipped }` after a close, or null. */
export function tmuxPage(token, hosts, done = null) {
  const banner = done
    ? `<div class="banner${done.skipped ? " warn" : ""}">Closed ${esc(done.closed)}${done.skipped ? `, skipped ${esc(done.skipped)} that changed since this page was drawn` : ""}.</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>streamdeck tmux</title>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    ${iconLinks(token)}
    <style>${HEADER_CSS}${STYLE}</style></head><body>
    ${iconHeader(token, "tmux", "Tmux")}
    <main>
      <p class="sub">Every tmux session on your remote hosts, sorted into what is safe to close and what is in use. Closing ends its process; the conversation stays on disk and can be resumed. Each one is checked again right before it is closed.</p>
      ${banner}
      ${hosts.length ? hosts.map((h) => hostSection(token, h)).join("") : `<p class="sub">No remote host is open.</p>`}
    </main>
    <script>${SCRIPT}</script></body></html>`;
}
