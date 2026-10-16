// The test queue page: every busy remote queue (runlock.mjs) as the deck's
// board reads it — the cores budget, then each run holding or waiting, with how
// long. Server-rendered and read-only; it re-reads itself every few seconds.
import { esc } from "./html.mjs";
import { HEADER_CSS, iconHeader, iconLinks } from "./board-page.mjs";
import { STATE_COLORS, formatAge } from "./render.mjs";

const STYLE = `
  body { margin: 0; background: #0b0b0b; color: #e0e0e0; font: 14px/1.45 -apple-system, system-ui, sans-serif }
  main { max-width: 980px; margin-inline: auto; padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px)) }
  h2 { font-size: 16px; margin: 22px 0 8px }
  .sub { color: #9e9e9e; font-size: 13px }
  .budget { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 14px }
  .cell { min-width: 120px; padding: 10px 14px; border-radius: 8px; color: #fff }
  .cell b { display: block; font-size: 22px }
  .cell span { font-size: 12px; opacity: .85 }
  .run { display: grid; grid-template-columns: 6px 64px minmax(0, 1fr) 170px 130px; gap: 4px 12px; align-items: center; padding: 9px 14px; background: #151515; border: 1px solid #262626; border-radius: 8px; margin-bottom: 6px }
  .run i { align-self: stretch; border-radius: 3px }
  .cores { font-weight: 700; font-variant-numeric: tabular-nums }
  .who { min-width: 0; overflow-wrap: anywhere }
  .who small { display: block; color: #9e9e9e }
  .bar { height: 12px; border-radius: 6px; background: #262626; overflow: hidden; display: block }
  .bar i { display: block; height: 100%; align-self: auto }
  .ended i { background: ${STATE_COLORS.requires_action} }
  h3 { font-size: 14px; margin: 16px 0 6px; color: #ef9a9a }
  .time { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums }`;

// A running job's bar fills toward runlock's estimate; a waiting one says where
// it stands in line. Nothing when runlock gave no estimate.
const progress = (t, tiles) =>
  t.frac != null
    ? `<span class="bar"><i style="width:${Math.round(t.frac * 100)}%;background:${TONE[t.tone]}"></i></span>`
    : t.pos != null
      ? `<span class="sub">${esc(t.pos)} of ${esc(tiles.filter((x) => x.pos != null).length)} in line</span>`
      : `<span></span>`;

const TONE = { running: STATE_COLORS.busy, queued: STATE_COLORS.waiting, stuck: STATE_COLORS.requires_action };

/** `queues` is `[{ host, budget, tiles, ended }]` as index.mjs builds it from queueBudget/queueTiles/parseEnded. */
export function queuePage(token, queues, now = Date.now()) {
  const endedRows = (ended) =>
    ended?.length
      ? `<h3>Ended early, last 24 hours</h3>${ended
          .map((e) => `<div class="run ended"><i></i><span class="cores">${esc(formatAge((now - e.at) / 1000) || "now")}</span><span class="who">${esc(e.requestor)} · ${esc(e.ended)}<small>${esc(e.label)}${e.ranS != null ? ` · ran ${esc(formatAge(e.ranS))}` : e.waitedS != null ? ` · waited ${esc(formatAge(e.waitedS))}` : ""}</small></span><span class="time"><small class="sub" style="display:block;font-weight:400">ago</small></span></div>`)
          .join("")}`
      : "";
  const host = ({ host, budget, tiles, ended }) => `<h2>${esc(host)}</h2>
    <div class="budget">${budget.map((b) => `<div class="cell" style="background:${TONE[b.tone] ?? STATE_COLORS.idle}"><b>${esc(b.big)}</b><span>${esc(b.title)} · ${esc(b.line)}</span></div>`).join("")}</div>
    ${tiles.map((t) => `<div class="run"><i style="background:${TONE[t.tone] ?? STATE_COLORS.idle}"></i><span class="cores">${esc(t.big)}</span><span class="who">${esc(t.title)}<small>${esc(t.line)}</small></span>${progress(t, tiles)}<span class="time">${esc(t.wait ?? t.age)}<small class="sub" style="display:block;font-weight:400">${esc(t.tone === "running" ? "running" : "waiting")}${t.eta ? ` · ${esc(t.eta)}` : ""}</small></span></div>`).join("")}${endedRows(ended)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>streamdeck queue</title>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta http-equiv="refresh" content="5">
    ${iconLinks(token)}
    <style>${HEADER_CSS}${STYLE}</style></head><body>
    ${iconHeader(token, "queue", "Queue")}
    <main>
      <p class="sub">Test runs holding or waiting for cores on your remote hosts, in the order the host will admit them.</p>
      ${queues.length ? queues.map(host).join("") : `<p class="sub">No test run is queued or running, and none ended early in the last day.</p>`}
    </main></body></html>`;
}
