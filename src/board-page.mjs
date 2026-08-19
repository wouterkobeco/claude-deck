// The board, mirrored as a web page — for an iPad propped up beside the deck.
//
// Same data, same palette, same rules as the 15 keys; the one thing it does
// not inherit is the deck's geometry. An iPad is not 15 keys of 72px, so this
// board has no slot cap (every session gets a tile, and the page scrolls) and
// its grid is yours to set: columns, rows and font size, from the gear.
//
// Everything is server-rendered, like the config page beside it, and for the
// same reason — a POST handler and a rendered fragment are things
// `config-check` can drive with a real server and a real fetch, and client JS
// inside a template literal is the one thing in this project nothing can lint,
// import or run. What is left in SCRIPT is what only a browser can answer:
// where the pointer is, how many lines of text fit at this size, and which
// tiles actually changed since the last poll.
import { STATE_COLORS, MARKER_COLORS, usageColor, CONTEXT_CRITICAL } from "./render.mjs";
import { esc, colour } from "./html.mjs";

// The three views this thing has, as one header on every one of them. It used
// to be icons on the board and text links on the config pages, which made
// "where am I and how do I get back" a different question depending on where
// you already were.
//
// Exported with its CSS because config-server.mjs renders the other two pages
// and importing the markup without the rules that make it a header is how the
// two drift apart.
export const HEADER_CSS = `
  /* Saved to an iPhone's home screen the page runs standalone under
     viewport-fit=cover, so it owns the whole screen — status bar, notch and
     home indicator included — and the header sat underneath the clock. These
     four are the insets iOS reports for that; they are 0 in a browser tab and
     0 on every other platform, so nothing else moves.
     Held as variables rather than used inline because env() cannot be set from
     a devtools console or a test, and a layout nobody can drive is a layout
     that gets this wrong twice. */
  :root {
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --safe-left: env(safe-area-inset-left, 0px);
    --safe-right: env(safe-area-inset-right, 0px);
    /* What the sheet, the panel and the scrim start below. */
    --head: calc(56px + var(--safe-top));
  }
  .head { position: sticky; top: 0; z-index: 11; background: var(--page-bg, #0b0b0b);
          flex: none; height: var(--head); padding-top: var(--safe-top);
          display: flex; align-items: center; gap: 10px; box-sizing: border-box;
          padding-left: calc(14px + var(--safe-left));
          padding-right: calc(14px + var(--safe-right));
          border-bottom: 1px solid #1e1e1e }
  .head h1 { font-size: 12px; letter-spacing: .18em; text-transform: uppercase;
             color: #9e9e9e; font-weight: 600; margin: 0; white-space: nowrap }
  .head .spacer { flex: 1 }
  .head .offline-note { display: none; font-size: 12px; color: #ff8a65 }
  .icon { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px;
          display: grid; place-items: center; cursor: pointer;
          background: #262626; color: #9e9e9e; text-decoration: none }
  /* Which view you are looking at, said the same way the periods bar says it. */
  .icon.on { background: #3a3a3a; color: #ffffff }`;

const ICONS = {
  // The board: the same nine keys the home-screen icon draws, so the way back
  // to it looks like the thing it goes back to.
  board: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${[0, 1, 2]
    .flatMap((r) => [0, 1, 2].map((c) => `<rect x="${c * 5.5}" y="${r * 5.5}" width="4" height="4" rx="1" fill="currentColor"/>`))
    .join("")}</svg>`,
  activity: `<svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor"/>
    <rect x="6.5" y="5" width="3" height="10" rx="1" fill="currentColor"/>
    <rect x="12" y="1" width="3" height="14" rx="1" fill="currentColor"/></svg>`,
};

/**
 * `here` is one of "board" | "activity" | "accents".
 *
 * **Every icon means the same thing on every page, including the gear.**
 * Settings are the board's sheet — layout, font, colours — and that is where
 * the gear goes from anywhere: on the board it toggles the sheet, elsewhere it
 * is a link to the board *with the sheet already open* (`&settings=1`). It
 * pointed at the accents page from the config pages for one release, which
 * meant the same icon landed you somewhere else depending on where you
 * pressed it — the one thing a fixed icon bar exists to prevent.
 */
export function iconHeader(token, here, title = "Deck") {
  const t = esc(token);
  const link = (view, href, label) =>
    `<a class="icon${here === view ? " on" : ""}" href="${href}?t=${t}" title="${label}">${ICONS[view]}</a>`;
  return `<header class="head" data-here="${here}">
    <h1>${esc(title)}</h1>
    <span class="offline-note">daemon not responding</span>
    <span class="spacer"></span>
    ${link("board", "/board", "board")}
    ${link("activity", "/activity", "activity")}
    ${
      here === "board"
        ? `<button class="icon" id="gear" title="settings">⚙</button>`
        : `<a class="icon" href="/board?t=${t}&amp;settings=1" title="settings">⚙</a>`
    }
  </header>`;
}

// Shared with every page that renders the header, for the same reason its CSS
// is: a gesture that only worked on one of the three would be a worse bug
// than not having it, once you got used to it existing.
//
// Nothing on any of these pages is meant to be wider than the viewport, so a
// horizontal drag has no scroll to spend — each page's own CSS blocks it with
// overflow-x:hidden, which leaves the gesture unclaimed. This claims it: swipe
// or trackpad-scroll left/right steps through the header's own icon order.
//
// Only "board" and "activity" are steps — "settings" isn't a page of its own,
// it's the board's sheet, and including it as a third step made every other
// swipe land back on the board with the sheet open, which looks identical to
// the board with it closed. That read as the same view twice in a row, not a
// third destination, so it's the gear icon's job alone (click it, or its link
// to the board with the sheet already open) and never the swipe's.
// A header with no data-here (the accents page, which carries no icon of its
// own) has no place in the order, so `at` comes back -1 and the whole thing
// opts out rather than guessing.
//
// `.handle` and `input` are excluded from starting a swipe because both are
// draggable in their own right (the corner grip, the accents page's reorder
// handles, the font-size slider) — without the exclusion, dragging one more
// than the threshold would fire a page change out from under it.
export const HEADER_SCRIPT = `
(() => {
  const CYCLE = ["board", "activity"];
  const at = CYCLE.indexOf(document.querySelector(".head")?.dataset.here);
  if (at < 0) return;

  function go(view) {
    location.href = "/" + view + location.search;
  }

  // dx < 0 is a leftward swipe (or, for wheel, its scroll-right equivalent) —
  // read as "forward", the same sense a book page turns.
  function step(dx) {
    if (!dx) return;
    go(CYCLE[(at + (dx < 0 ? 1 : CYCLE.length - 1)) % CYCLE.length]);
  }

  let x0 = null, y0 = null;
  document.addEventListener("touchstart", (e) => {
    if (e.target.closest("input, .handle")) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = y0 = null;
    // Mostly horizontal and past a real threshold, or an ordinary vertical
    // scroll would fire this on every page.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx);
  }, { passive: true });

  // A trackpad's horizontal scroll fires a burst of small-deltaX wheel events
  // per gesture, not one — the cooldown turns that burst into a single step
  // instead of flipping through every page in it.
  let cooling = false;
  document.addEventListener("wheel", (e) => {
    if (cooling || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    cooling = true;
    setTimeout(() => (cooling = false), 500);
    step(-e.deltaX);
  }, { passive: true });
})();
`;

const STYLE = `
  :root {
    color-scheme: dark;
    --page-bg: #0b0b0b;
    --cols: 5; --rows: 3; --fs: 9; --gap: 8px; --lines: 3;
    /* One place, because two things need it in step: the line box the browser
       lays out, and the max-height that enforces the clamp below. */
    --lh: 1.2;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent }
  body {
    margin: 0; background: #0b0b0b; color: #e0e0e0;
    font-family: -apple-system, system-ui, sans-serif;
    height: 100dvh; display: flex; flex-direction: column;
    overflow: hidden; overscroll-behavior: none; user-select: none;
  }
  /* Three failed polls in a row. A stopped daemon must not leave a perfectly
     plausible frozen board up — the same honesty unreachableHosts exists for
     on the deck. */
  body.stale main { opacity: .35; filter: grayscale(1) }
  body.stale .offline-note { display: block }

  button { font: inherit; border: 0; border-radius: 5px; background: #262626;
           color: #e0e0e0; padding: 7px 12px; font-size: 12px; cursor: pointer;
           font-weight: 600; letter-spacing: .04em }
  button:active { background: #3a3a3a }
  .icon { font-size: 17px }

  /* A size container, so the grid below can measure itself against both of
     its own axes rather than against the window. */
  main { flex: 1; min-height: 0; container-type: size;
         padding: var(--gap) calc(var(--gap) + var(--safe-right))
                  calc(var(--gap) + var(--safe-bottom)) calc(var(--gap) + var(--safe-left));
         overflow-y: auto; overscroll-behavior: contain }
  /* Rows set a key *height* and columns its width, and on a real screen those
     two numbers are nothing like each other: three columns of a 390px phone
     against a fifth of its height is a tall key in portrait and a letterbox in
     landscape. So a key is the *smaller* of the two, in both directions —
     --key is that size, it is the row height, and it also caps the width so a
     wide column leaves space beside the key rather than stretching it. Square
     on any screen, in any orientation; the board scrolls for the rest. */
  .grid { --key: min(
            (100cqh - (var(--rows) - 1) * var(--gap)) / var(--rows),
            (100cqw - (var(--cols) - 1) * var(--gap)) / var(--cols));
          display: grid; grid-template-columns: repeat(var(--cols), 1fr);
          grid-auto-rows: var(--key);
          gap: var(--gap); align-content: start; min-height: 100% }
  .grid > * { justify-self: center; width: min(100%, var(--key)) }

  /* Every dimension inside a key is in cqh/cqw against the key itself, so rows
     and --fs scale the caps, body, markers and task squares together. */
  .key { container-type: size; border-radius: 7px; overflow: hidden;
         position: relative; display: flex; flex-direction: column;
         background: ${STATE_COLORS.idle} }
  .key:active { filter: brightness(1.25) }
  /* requires_action sits on waiting's gold and lifts to bright gold, exactly
     as renderKey draws it — a flash within the family, not a colour fighting
     a grey. ~0.8s, the deck's own beat. */
  .key.blocked { animation: blink .8s steps(1, end) infinite }
  @keyframes blink { 50% { background: #ffc107 } }
  .key.dark { background: #1b1b1b }

  .bar { flex: none; height: 17cqh; min-height: 14px; position: relative;
         padding: 1.5cqh 4cqw 0; overflow: hidden }
  .caps { font-size: calc(var(--fs) * .72cqh); line-height: 1.05; font-weight: 700;
          letter-spacing: .06em; text-transform: uppercase; color: #000000cc;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .gauge { position: absolute; left: 0; bottom: 0; height: 4cqh; min-height: 3px;
           width: 100%; background: #00000055 }
  .gauge i { display: block; height: 100% }
  /* The other half of gaugeColor's square wave. No 0% keyframe, so the steady
     colour is the inline one usageColor already chose. */
  .gauge i.crit { animation: gaugeflash .8s steps(1, end) infinite }
  @keyframes gaugeflash { 50% { background: #ffffff } }

  .body { flex: 1; min-height: 0; display: flex; gap: 2.5cqw;
          padding: 5cqh 4cqw 3cqh; overflow: hidden }
  .markers { flex: none; display: flex; flex-direction: column; gap: 1.4cqh; padding-top: .6cqh }
  .markers i { display: block; width: 4cqw; min-width: 3px; height: 8cqh;
               min-height: 5px; border-radius: 1px }
  /* Clamped to whole lines rather than clipped mid-glyph. This is renderKey's
     maxLines, computed in the browser because only the browser knows how
     tall a key ended up — a half-line peeking out under the task squares is
     what it exists to stop. */
  .text { flex: 1; min-width: 0; color: #fff; font-weight: 600;
          font-size: calc(var(--fs) * 1cqh); line-height: var(--lh);
          display: -webkit-box; -webkit-box-orient: vertical;
          -webkit-line-clamp: var(--lines); line-clamp: var(--lines);
          overflow: hidden; word-break: break-word;
          /* Both halves are load-bearing. line-clamp puts the ellipsis on the
             last line it keeps, but it paints the line after it anyway when
             the element was stretched to a taller flex box — which is exactly
             the line that ended up under the task squares. align-self stops
             the stretch, max-height clips whatever it paints regardless. */
          align-self: flex-start;
          max-height: calc(var(--lines) * var(--lh) * 1em) }
  .text.empty { color: #ffffff88 }
  .foot { flex: none; display: flex; gap: 1.5cqw; padding: 4cqh 4cqw }
  .foot i { flex: 1; height: 5cqh; min-height: 3px; border-radius: 1px; background: #ffffff33 }
  .foot i.done { background: #ffffffdd }
  .foot i.active { background: #ffffff99 }

  /* The three reserved keys. Dark and quiet, like their tiles on the deck.
     Padding in %, not cqh: this rule is on .key itself, and an element is
     never its own container — cqh here resolved against <main>, so on a
     landscape phone the padding came out 12.7px instead of 3.9px and squeezed
     the usage tile's contents into 71px of a 97px key. Percentages resolve
     against this element's own box, and the key is square. Every rule below
     is on a *descendant*, where cqh means what it looks like it means. */
  .tile { justify-content: center; align-items: center; text-align: center;
          padding: 5%; gap: 2px }
  /* Sized to the key, not to --fs. That slider exists to set how much of a
     session's *title* you can read, and these three tiles hold no title — a
     fixed count, a caps label and an age. Scaling them with it meant a font
     chosen so four lines fit a session key overflowed a tile holding two
     percentages, two labels and two bars, and the caps were what got cut. */
  .tile .lbl { font-size: 9cqh; letter-spacing: .14em;
               text-transform: uppercase; color: #ffffff99; font-weight: 700 }
  .tile .val { font-size: 26cqh; font-weight: 700; color: #fff;
               font-variant-numeric: tabular-nums; line-height: 1 }
  .tile .sub { font-size: 8cqh; color: #757575 }
  .tile.alert { background: #c62828 }
  .tile.alert .sub { color: #ffffffcc }
  /* renderUsage, unchanged: two halves split by a hair line, each a caps
     label, the percentage, and one thin bar. Nothing else — this key is read
     from across a room, not studied. */
  /* align-self:stretch and flex:1, not height:100%: .tile centres its children
     in a column of automatic height, so a percentage height had nothing to
     resolve against and the halves fell back to sizing on their own content —
     which then clipped, because each holds more than it had room for. The
     whole tile is the box; these two split it. */
  .usage { flex: 1; align-self: stretch; min-height: 0; width: 100%;
           display: flex; flex-direction: column }
  /* min-height:0 and the clip are what stop a short key spilling its second
     half past the bottom edge: two percentages, two caps rows and two bars is
     the most crowded tile on the board, and a landscape phone makes every key
     smaller than a portrait one. */
  .usage .half { flex: 1; min-height: 0; overflow: hidden;
                 display: flex; flex-direction: column; align-items: center;
                 justify-content: center; gap: 1cqh; padding: 0 7cqw }
  .usage .bar { width: 100%; height: 5cqh; min-height: 3px; border-radius: 2px;
                background: #ffffff22; overflow: hidden }
  .usage .bar i { display: block; height: 100% }

  .sheet { position: fixed; inset: var(--head) 0 0 auto; width: min(380px, 88vw);
           background: #141414; border-left: 1px solid #262626; z-index: 10;
           padding: 18px calc(20px + var(--safe-right)) calc(18px + var(--safe-bottom)) 20px;
           overflow-y: auto;
           transform: translateX(100%); transition: transform .18s ease;
           display: flex; flex-direction: column; gap: 22px }
  .sheet.on { transform: none }
  .scrim { position: fixed; inset: var(--head) 0 0 0; background: #0008; z-index: 9; display: none }
  .scrim.on { display: block }
  .sheet h2 { font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
              color: #757575; font-weight: 600; margin: 0 0 10px }
  .field { display: flex; align-items: center; gap: 12px; margin: 0 0 12px }
  .field .name { flex: 1; font-size: 13px; color: #e0e0e0 }
  .stepper { display: flex; align-items: center; gap: 2px; background: #1b1b1b;
             border-radius: 6px; padding: 2px }
  .stepper button { padding: 4px 11px; font-size: 15px; line-height: 1; background: #2a2a2a }
  .stepper b { min-width: 26px; text-align: center; font-size: 13px;
               font-variant-numeric: tabular-nums }
  input[type=range] { width: 100%; accent-color: #4fc3f7 }
  .note { font-size: 12px; color: #757575; line-height: 1.5; margin: 0 }
  .note b { color: #bdbdbd }
  .fsrow { display: flex; align-items: center; gap: 12px }
  .fsrow b { font-size: 13px; width: 34px; text-align: right; color: #9e9e9e;
             font-variant-numeric: tabular-nums }
  .proj { display: flex; align-items: center; gap: 10px; margin: 0 0 12px }
  .proj .nm { flex: 1; font-size: 12px; font-weight: 600; letter-spacing: .06em;
              text-transform: uppercase; color: #bdbdbd; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap }
  .swatches { display: flex; gap: 5px; flex: none }
  .swatches i { width: 20px; height: 20px; border-radius: 4px; display: block;
                border: 2px solid transparent; cursor: pointer }
  .swatches i.on { border-color: #fff }
  /* margin-top:auto rather than a fixed position: the sheet is a flex column,
     so this sits under the last section on a short list and at the bottom of
     the panel on a tall one, without ever overlapping what is above it. */
  .sver { margin: auto 0 0; padding-top: 8px; text-align: center;
          font-size: 12px; color: #616161 }

  /* The detail panel. Deliberately not twelve squares: the deck's version of
     this view exists inside a 5×3 grid of 72px keys and spends most of its
     design on that constraint — a task window that re-centres, subagents
     pinned to a tail so a long plan can't push them off, a back key carved
     out of a fixed index. None of that is true here, so the task list is the
     whole task list and everything is as long as it needs to be. */
  .panel { position: fixed; inset: var(--head) 0 0 auto; width: min(560px, 94vw);
           background: #141414; border-left: 1px solid #262626; z-index: 10;
           overflow-y: auto; transform: translateX(100%); transition: transform .18s ease;
           display: flex; flex-direction: column }
  .panel.on { transform: none }
  .phead { position: relative; padding: 16px calc(20px + var(--safe-right)) 18px 20px; border-bottom: 1px solid #262626 }
  .phead .accent { position: absolute; inset: 0 auto 0 0; width: 5px }
  .phead .proj { font-size: 11px; letter-spacing: .16em; text-transform: uppercase;
                 font-weight: 700; color: #9e9e9e; margin: 0 0 6px }
  .phead .title { font-size: 19px; font-weight: 600; color: #fff; line-height: 1.3;
                  word-break: break-word }
  .phead .title.empty { color: #ffffff66 }
  .pclose { position: absolute; top: 12px; right: 12px; width: 34px; height: 34px;
            border-radius: 8px; background: #262626; color: #e0e0e0; font-size: 16px;
            display: grid; place-items: center; border: 0; cursor: pointer }
  .pill { display: inline-block; margin: 12px 8px 0 0; padding: 4px 10px; border-radius: 999px;
          font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
          color: #fff }
  .pbody { padding: 18px calc(20px + var(--safe-right)) calc(28px + var(--safe-bottom)) 20px; display: flex; flex-direction: column; gap: 22px }
  .pbody h3 { font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
              color: #757575; font-weight: 600; margin: 0 0 10px }
  .facts { display: grid; grid-template-columns: 78px 1fr; gap: 9px 14px; font-size: 13px;
           align-items: center }
  .facts dt { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #757575;
              font-weight: 600 }
  .facts dd { margin: 0; color: #e0e0e0; word-break: break-all;
              font-variant-numeric: tabular-nums }
  .ctx { display: flex; align-items: center; gap: 10px }
  .ctx .track { flex: 1; height: 6px; border-radius: 3px; background: #ffffff1a; overflow: hidden }
  .ctx .track i { display: block; height: 100% }
  /* The same three task colours renderTask draws with, as rows rather than
     keys — done dimmed, in progress bright, still to do quiet. */
  .task { display: flex; gap: 12px; padding: 9px 12px; border-radius: 5px;
          margin: 0 0 4px; font-size: 14px; line-height: 1.35 }
  .task .n { flex: none; width: 20px; text-align: right; font-variant-numeric: tabular-nums;
             opacity: .7 }
  .task.completed { background: #1b3a1e; color: #ffffff77 }
  .task.in_progress { background: #2e7d32; color: #ffffff; font-weight: 600 }
  .task.pending { background: #1b1b1b; color: #ffffffaa }
  .agent { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 5px;
           background: #1b1b1b; margin: 0 0 4px; font-size: 13px }
  .agent .dot { flex: none; width: 8px; height: 8px; border-radius: 2px }
  .agent .nm { flex: 1; color: #e0e0e0; word-break: break-word }
  .agent .st { flex: none; font-size: 11px; color: #757575; letter-spacing: .1em;
               text-transform: uppercase }
  .none { color: #616161; font-size: 13px }

  /* One grip, two numbers: drag left/right for columns, up/down for rows —
     what a window grip already means, in the corner it resizes toward. */
  .handle { position: fixed; right: calc(6px + var(--safe-right)); bottom: calc(6px + var(--safe-bottom)); width: 44px; height: 44px;
            border-radius: 10px; background: #1b1b1bdd; border: 1px solid #2e2e2e;
            display: grid; place-items: center; color: #757575; font-size: 17px;
            cursor: nwse-resize; touch-action: none; z-index: 5 }
  .handle.on { background: #2a2a2add; color: #e0e0e0 }
  .readout { position: fixed; right: calc(58px + var(--safe-right)); bottom: calc(14px + var(--safe-bottom)); font-size: 12px; color: #9e9e9e;
             background: #1b1b1bdd; padding: 5px 9px; border-radius: 6px;
             font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .12s;
             pointer-events: none; z-index: 5 }
  .readout.on { opacity: 1 }`;

// A body with nothing in it is CLEAR on the deck, drawn by renderKey for any
// empty label — a session nobody has typed into, or one just cleared. The same
// word here, for the same reason: name-or-cwd would look like a real answer.
const body = (k) => `<div class="body">${
  k.nested?.length || k.shell
    ? `<div class="markers">${[
        ...(k.shell ? [MARKER_COLORS.shell] : []),
        ...k.nested.map((s) => MARKER_COLORS[s] ?? MARKER_COLORS.idle),
      ]
        .map((c) => `<i style="background:${c}ee"></i>`)
        .join("")}</div>`
    : ""
}<div class="text${k.label ? "" : " empty"}">${esc(k.label || "CLEAR")}</div></div>`;

const gauge = (pct) =>
  typeof pct !== "number"
    ? ""
    : `<div class="gauge"><i class="${pct >= CONTEXT_CRITICAL ? "crit" : ""}" style="width:${Math.min(
        100,
        Math.max(0, pct)
      )}%;background:${usageColor(pct)}"></i></div>`;

const bar = (k) =>
  `<div class="bar" style="background:${colour(k.accent)}"><div class="caps">${esc(k.project)}</div>${gauge(
    k.context
  )}</div>`;

const usageHalf = (caps, pct) =>
  `<div class="half">
     <div class="lbl">${caps}</div>
     <div class="val">${typeof pct === "number" ? Math.round(pct) + "%" : "—"}</div>
     <div class="bar"><i style="width:${typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 0}%;background:${usageColor(
       pct ?? 0
     )}"></i></div>
   </div>`;

/**
 * One tile. `data-id` is what the poll diffs on, and `data-session` is what a
 * tap posts — only session tiles carry one, so the reserved three and an
 * unreachable stand-in are inert by construction rather than by a check in the
 * handler.
 */
function tile(k, token) {
  const id = ` data-id="${esc(k.id)}"`;
  if (k.kind === "usage") {
    // An anchor, not a click handler: this is a navigation, and the deck's own
    // usage key opens the stats board on a press for the same reason. Native
    // means it needs nothing from SCRIPT and survives the poll's diffing
    // unchanged, since the markup is what gets compared either way.
    return `<a class="key dark tile" href="/activity?t=${esc(token)}"${id}><div class="usage">${usageHalf(
      "Session",
      k.session
    )}${usageHalf("Week", k.week)}</div></a>`;
  }
  if (k.kind === "attention" || k.kind === "free") {
    const alert = k.kind === "attention" && k.count > 0;
    return `<div class="key dark tile${alert ? " alert" : ""}"${id}>
      <div class="val">${esc(k.count)}</div>
      <div class="lbl">${k.kind === "attention" ? "blocked" : "free"}</div>
      ${k.longest ? `<div class="sub">${esc(k.longest)}</div>` : ""}
    </div>`;
  }
  // A host that can't be reached keeps its block's slot, its accent and its
  // name, and says so in grey — never red, which is reserved for things
  // blocked on you, and never absent, which is the one dishonest option.
  if (k.kind === "offline") {
    return `<div class="key"${id} style="background:${STATE_COLORS.idle}">${bar(k)}<div class="body"><div class="text">${esc(
      k.label
    )}</div></div></div>`;
  }
  // The block's colour, not this session's: `state` arrives already folded
  // over its subagents, the same mostUrgent() call refresh() makes.
  const blocked = k.state === "requires_action";
  const background = blocked ? STATE_COLORS.waiting : STATE_COLORS[k.state] ?? STATE_COLORS.idle;
  return `<div class="key${blocked ? " blocked" : ""}"${id} data-session="${esc(k.id)}" style="background:${background}">
    ${bar(k)}
    ${body(k)}
    ${
      k.squares?.length
        ? `<div class="foot">${k.squares.map((s) => `<i class="${s === "todo" ? "" : esc(s)}"></i>`).join("")}</div>`
        : ""
    }
  </div>`;
}

const STATE_PILL = {
  busy: STATE_COLORS.busy,
  shell: STATE_COLORS.shell,
  waiting: STATE_COLORS.waiting,
  requires_action: STATE_COLORS.requires_action,
  compacting: STATE_COLORS.busy,
  idle: STATE_COLORS.idle,
};

/**
 * One session, at length. The deck's version of this view spends most of its
 * design on fitting into 5×3 keys of 72px — a task window that re-centres so
 * the in-progress one stays visible, subagents pinned to a tail so a twenty-task
 * plan can't push them off, a back key carved out of a fixed index. None of
 * those constraints exist here, so this shows the whole task list and every
 * subagent, and nothing is truncated to fit a square.
 *
 * Returns the panel's *contents*, not the panel: the shell stays in the page
 * and only this is replaced on a poll, so opening and closing is CSS rather
 * than markup.
 */
export function detailPanel(d) {
  if (!d) {
    // It ended while you were looking at it. Say so rather than leaving
    // stale-but-plausible tasks up — the same call refreshDetail makes when
    // its session disappears mid-view.
    return `<div class="phead"><div class="title empty">this session has ended</div>
      <button class="pclose" id="pclose" title="close">✕</button></div>`;
  }
  const done = d.tasks.filter((t) => t.status === "completed").length;
  return `<div class="phead">
      <span class="accent" style="background:${colour(d.accent)}"></span>
      <button class="pclose" id="pclose" title="close">✕</button>
      <p class="proj">${esc(d.project)}</p>
      <div class="title${d.label ? "" : " empty"}">${esc(d.label || "nothing said in this session yet")}</div>
      <span class="pill" style="background:${STATE_PILL[d.state] ?? STATE_COLORS.idle}">${esc(
        d.state === "requires_action" ? "blocked on you" : d.state
      )}${d.age ? ` · ${esc(d.age)}` : ""}</span>
    </div>
    <div class="pbody">
      <div>
        <h3>Session</h3>
        <dl class="facts">
          <dt>Context</dt><dd>${
            typeof d.context === "number"
              ? `<span class="ctx"><span class="track"><i style="width:${Math.min(
                  100,
                  Math.max(0, d.context)
                )}%;background:${usageColor(d.context)}"></i></span>${d.context}%</span>`
              : "—"
          }</dd>
          <dt>Model</dt><dd>${esc(d.model)}</dd>
          <dt>Where</dt><dd>${esc(d.host ? `${d.host}:${d.cwd}` : d.cwd)}</dd>
        </dl>
      </div>
      <div>
        <h3>Tasks${d.tasks.length ? ` · ${done} of ${d.tasks.length}` : ""}</h3>
        ${
          d.tasks.length
            ? d.tasks
                .map(
                  (t) =>
                    `<div class="task ${esc(t.status)}"><span class="n">${esc(t.n)}</span><span>${esc(
                      t.subject
                    )}</span></div>`
                )
                .join("")
            : '<p class="none">no task list — this session has not used one</p>'
        }
      </div>
      <div>
        <h3>Subagents</h3>
        ${
          d.nested.length
            ? d.nested
                .map(
                  (n) =>
                    `<div class="agent"><span class="dot" style="background:${
                      MARKER_COLORS[n.state] ?? MARKER_COLORS.idle
                    }"></span><span class="nm">${esc(n.label || "—")}</span><span class="st">${esc(
                      n.state
                    )}</span></div>`
                )
                .join("")
            : '<p class="none">none running</p>'
        }
      </div>
    </div>`;
}

/**
 * The grid's children on their own — what the 2s poll fetches and diffs.
 *
 * Takes the token because one tile is a link: the usage tile opens the status
 * page, the way the deck's usage key opens the stats board.
 */
export const boardGrid = (keys, token) => keys.map((k) => tile(k, token)).join("");

const sheetProjects = (projects, palette) =>
  projects
    .map(
      (p) => `<div class="proj" data-key="${esc(p.key)}">
        <span class="nm">${esc(p.name)}</span>
        <span class="swatches">${palette
          .map((c) => `<i data-accent="${c}" style="background:${c}"${c === p.accent ? ' class="on"' : ""}></i>`)
          .join("")}</span>
      </div>`
    )
    .join("");

export function boardPage(token, { keys, projects, palette, version }) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <!-- What iOS fills the "Add to Home Screen" name field with, and what ends
       up under the icon. Android takes the same name from the manifest's
       short_name; the two are kept identical on purpose, or the same app is
       called two things depending on the phone it is on. -->
  <meta name="apple-mobile-web-app-title" content="Claude Deck">
  <meta name="theme-color" content="#0b0b0b">
  <link rel="manifest" href="/manifest.webmanifest?t=${esc(token)}">
  <link rel="apple-touch-icon" href="/icon-180.png?t=${esc(token)}">
  <link rel="icon" href="/icon-192.png?t=${esc(token)}">
  <title>Claude Deck</title><style>${HEADER_CSS}${STYLE}</style></head><body>
  ${iconHeader(token, "board")}

  <main><div class="grid" id="grid">${boardGrid(keys, token)}</div></main>

  <div class="scrim" id="scrim"></div>
  <aside class="sheet" id="sheet">
    <div>
      <h2>Layout</h2>
      <div class="field"><span class="name">Columns</span>
        <span class="stepper"><button data-step="cols:-1">−</button><b id="c">5</b><button data-step="cols:1">+</button></span></div>
      <div class="field"><span class="name">Rows</span>
        <span class="stepper"><button data-step="rows:-1">−</button><b id="r">3</b><button data-step="rows:1">+</button></span></div>
    </div>
    <div>
      <h2>Font size</h2>
      <div class="fsrow"><input type="range" id="fs" min="5" max="22" step="1" value="9"><b id="fsv">13</b></div>
    </div>
    <div>
      <h2>Home screen</h2>
      <button id="install" hidden>Add to home screen</button>
      <p class="note" id="ios-note">On iPhone or iPad: <b>Share</b> → <b>Add to Home Screen</b>. Neither
      Safari nor Chrome lets a page do this for you.</p>
    </div>
    <div>
      <h2>Colours</h2>
      <div id="projects">${sheetProjects(projects, palette)}</div>
    </div>
    ${version ? `<p class="sver">Claude Deck v${esc(version)}</p>` : ""}
  </aside>

  <aside class="panel" id="panel"></aside>

  <div class="readout" id="readout">5 × 3</div>
  <div class="handle" id="handle">⇲</div>
  <script>${HEADER_SCRIPT}</script>
  <script>${SCRIPT}</script>
  </body></html>`;
}

// The client's whole job, and nothing that could be decided on the server is
// in here: which tiles changed since the last poll, how many lines of text fit
// at this size, and where the pointer went. Everything else — what a tile
// says, what colour it is, whether a gauge is critical — arrives rendered.
//
// The layout numbers live in localStorage rather than on the daemon: they are
// about *this* screen, and a phone and an iPad looking at the same board want
// different ones.
const SCRIPT = `
const root = document.documentElement;
const grid = document.getElementById("grid");
const sheet = document.getElementById("sheet");
const scrim = document.getElementById("scrim");
const gear = document.getElementById("gear");
const num = (v) => +getComputedStyle(root).getPropertyValue(v);

// How many whole body lines fit above the task squares — renderKey's maxLines,
// measured rather than derived, because only the browser knows how tall a key
// ended up at this rows/font pair.
function clampLines() {
  const boxes = [...document.querySelectorAll(".key .body")];
  const text = boxes[0]?.querySelector(".text");
  if (!text) return;
  root.style.setProperty("--lines", "99");
  const lh = parseFloat(getComputedStyle(text).lineHeight);
  // The *smallest* body on the board decides, not the first one: a key
  // carrying task squares has less room than one without, and a count taken
  // off a roomier key overflows the tighter one — which is the whole bug this
  // exists to prevent. The cost is a footless key sometimes showing one line
  // fewer than it could, which is invisible; the other way round is not.
  const room = Math.min(
    ...boxes.map((b) => {
      const cs = getComputedStyle(b);
      return b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    })
  );
  root.style.setProperty("--lines", Math.max(1, Math.floor(room / lh)));
}

const set = (cols, rows, fs) => {
  cols = Math.min(12, Math.max(1, cols));
  rows = Math.min(10, Math.max(1, rows));
  fs = Math.min(22, Math.max(5, fs));
  root.style.setProperty("--cols", cols);
  root.style.setProperty("--rows", rows);
  root.style.setProperty("--fs", fs);
  document.getElementById("c").textContent = cols;
  document.getElementById("r").textContent = rows;
  document.getElementById("fsv").textContent = fs;
  document.getElementById("fs").value = fs;
  document.getElementById("readout").textContent = cols + " × " + rows;
  localStorage.setItem(slot(), [cols, rows, fs].join(","));
  clampLines();
};
// A first visit in each orientation fits itself to the screen rather than
// guessing, and the two are remembered apart: a shape chosen in portrait is a
// letterbox in landscape, which is what rotating an iPhone used to produce.
//
// Deliberately not a device test: iPadOS Safari reports a Mac user-agent by
// default, so "is this a phone" is a question the browser will lie about,
// while the dimensions are the thing that was actually wrong.
//
// Rows come from the height and columns follow from the *key* that produces,
// so the keys come out square and fill the width instead of being centred in
// columns far wider than they are. The target is an absolute size — about
// 120px on a phone, 190px on anything bigger — because a key is read from a
// foot away whatever the screen is; the font is then the share of that key
// which lands near 18px, for the same reason.
const slot = () => "deck-layout-" + (innerWidth > innerHeight ? "l" : "p");

function fit() {
  const gap = 8;
  const head = 56;
  const target = Math.min(innerWidth, innerHeight) < 500 ? 120 : 190;
  const h = Math.max(120, innerHeight - head - 2 * gap);
  const w = Math.max(120, innerWidth - 2 * gap);
  const rows = Math.max(1, Math.min(10, Math.round(h / target)));
  const key = (h - (rows - 1) * gap) / rows;
  const cols = Math.max(1, Math.min(12, Math.round((w + gap) / (key + gap))));
  return [cols, rows, Math.max(5, Math.min(22, Math.round((18 / key) * 100)))];
}

// Re-read on rotate: each orientation keeps whatever it was last set to, and
// falls back to a fresh fit the first time it is seen.
function applySaved() {
  const saved = (localStorage.getItem(slot()) || "").split(",").map(Number);
  const f = fit();
  set(saved[0] || f[0], saved[1] || f[1], saved[2] || f[2]);
}
let showing = slot();
applySaved();
// resize rather than orientationchange: the latter is deprecated and fires
// before the new dimensions are readable on iOS, while resize covers a rotate,
// a split-screen drag and a desktop window all at once. Only a *change of
// orientation* re-applies a layout — every other resize just re-measures how
// many lines of body text fit.
addEventListener("resize", () => {
  if (slot() === showing) return clampLines();
  showing = slot();
  applySaved();
});

// ---- the poll ----------------------------------------------------------
// Replacing the grid wholesale every 2s would restart every CSS animation, so
// a blinking key would stutter on a 2s cycle. Compare each tile against what
// is already there and touch only what changed — the same thing btn.drawn does
// for the deck, done here because only the DOM knows what is currently up.
let fails = 0;
async function tick() {
  try {
    const res = await fetch("/board/grid" + location.search, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const fresh = new DOMParser().parseFromString(await res.text(), "text/html");
    const have = new Map([...grid.children].map((n) => [n.dataset.id, n]));
    [...fresh.body.children].forEach((next, i) => {
      const cur = have.get(next.dataset.id);
      let node = next;
      if (cur) {
        have.delete(next.dataset.id);
        if (cur.outerHTML === next.outerHTML) node = cur;
        else cur.replaceWith(next);
      }
      if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] ?? null);
    });
    have.forEach((gone) => gone.remove());
    fails = 0;
    document.body.classList.remove("stale");
    clampLines();
    await refreshDetail();
  } catch {
    // A stopped daemon leaves a board that looks perfectly healthy, which is
    // the one thing it must not do. Three misses, then say so.
    if (++fails >= 3) document.body.classList.add("stale");
  }
}
setInterval(tick, 2000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());

// ---- taps --------------------------------------------------------------
// A second tap on the same tile means "tell me more", the deck's own rule.
// Unlike the deck's, this one is decided in the browser and is right to be:
// the deck's lastPress is per-deck, and per-client is what the equivalent is
// here — two people looking at the same board must not steal each other's
// second tap. Any other tile breaks the chain, exactly as a key from another
// project does.
let lastTap = null;
const panel = document.getElementById("panel");
let openId = null;

grid.addEventListener("click", (e) => {
  const key = e.target.closest("[data-session]");
  if (!key) return;
  const id = key.dataset.session;
  // Both taps raise the window: between the two you may well have picked the
  // iPad up and put the Mac behind something, and a tap that opens a panel
  // while leaving you looking at Safari has done half its job.
  fetch("/focus" + location.search, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ session: id }),
  }).catch(() => {});
  if (lastTap === id) openDetail(id);
  else lastTap = id;
});

async function openDetail(id) {
  openId = id;
  panel.classList.add("on");
  scrim.classList.add("on");
  await refreshDetail();
}

function closeDetail() {
  openId = null;
  // Leaving clears the chain, the same thing setView does on the deck: without
  // it the tap that closed the panel is still sitting in lastTap, and the next
  // tap on that tile reopens what you just left.
  lastTap = null;
  panel.classList.remove("on");
  scrim.classList.remove("on");
  panel.replaceChildren();
}

async function refreshDetail() {
  if (!openId) return;
  const res = await fetch("/session" + location.search + "&id=" + encodeURIComponent(openId), { cache: "no-store" });
  if (!res.ok) return;
  const html = await res.text();
  // Most polls change nothing in here, and replacing a long task list you are
  // halfway down would throw your scroll away every 2s.
  if (html === panel.dataset.html) return;
  panel.dataset.html = html;
  // The age in the header ticks by the second for the first minute of a state,
  // so this really does re-render every poll for a while — and a long task
  // list you were halfway down must not jump back to the top each time.
  const at = panel.scrollTop;
  panel.replaceChildren(...new DOMParser().parseFromString(html, "text/html").body.childNodes);
  panel.scrollTop = at;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#pclose")) closeDetail();
});

// ---- settings ----------------------------------------------------------
const toggle = (on) => {
  sheet.classList.toggle("on", on);
  scrim.classList.toggle("on", on);
  gear.classList.toggle("on", on);
  if (!on) clampLines();
};
gear.addEventListener("click", () => toggle(!sheet.classList.contains("on")));

// Arriving from another page's gear. The flag is dropped from the URL straight
// away — the token has to stay (the poll reads location.search) but a reload
// should not keep reopening a sheet you closed.
if (new URLSearchParams(location.search).get("settings") === "1") {
  toggle(true);
  const clean = new URLSearchParams(location.search);
  clean.delete("settings");
  history.replaceState(null, "", location.pathname + "?" + clean);
}
scrim.addEventListener("click", () => {
  if (openId) closeDetail();
  else toggle(false);
});

document.addEventListener("click", (e) => {
  const step = e.target.dataset?.step;
  if (!step) return;
  const [what, by] = step.split(":");
  set(what === "cols" ? num("--cols") + +by : num("--cols"),
      what === "rows" ? num("--rows") + +by : num("--rows"), num("--fs"));
});
document.getElementById("fs").addEventListener("input", (e) => set(num("--cols"), num("--rows"), +e.target.value));

// The swatch marks itself and posts; the keys pick the new accent up on the
// next poll, from the server, like every other thing they show.
document.getElementById("projects").addEventListener("click", (e) => {
  const swatch = e.target.closest("[data-accent]");
  if (!swatch) return;
  [...swatch.parentElement.children].forEach((i) => i.classList.remove("on"));
  swatch.classList.add("on");
  // from=board: answer 204 and leave the page where it is, rather than the
  // 303 back to "/" the config page's own form wants.
  fetch("/accent" + location.search + "&from=board", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ folder: swatch.closest(".proj").dataset.key, accent: swatch.dataset.accent }),
  }).catch(() => {});
});

// ---- home screen -------------------------------------------------------
// Android fires this instead of showing its own prompt, so the page gets to
// put the offer somewhere sensible — but it is still a tap, and iOS has no
// equivalent at all: Safari will not let a site trigger Add to Home Screen,
// so all that can be done there is say where the button is.
let installer = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installer = e;
  document.getElementById("install").hidden = false;
  document.getElementById("ios-note").hidden = true;
});
document.getElementById("install").addEventListener("click", async () => {
  if (!installer) return;
  installer.prompt();
  await installer.userChoice;
  installer = null;
  document.getElementById("install").hidden = true;
});

// ---- the grip ----------------------------------------------------------
const handle = document.getElementById("handle");
const readout = document.getElementById("readout");
let start = null;
handle.addEventListener("pointerdown", (e) => {
  handle.setPointerCapture(e.pointerId);
  start = { x: e.clientX, y: e.clientY, c: num("--cols"), r: num("--rows") };
  handle.classList.add("on");
  readout.classList.add("on");
});
handle.addEventListener("pointermove", (e) => {
  if (!start) return;
  // 40px of travel per step, both axes. Toward the corner is smaller keys and
  // more of them; away is bigger.
  set(start.c + Math.round((e.clientX - start.x) / 40),
      start.r + Math.round((e.clientY - start.y) / 40), num("--fs"));
});
const done = () => {
  start = null;
  handle.classList.remove("on");
  readout.classList.remove("on");
};
handle.addEventListener("pointerup", done);
handle.addEventListener("pointercancel", done);
`;
