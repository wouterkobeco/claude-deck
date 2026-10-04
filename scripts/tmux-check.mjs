// Which tmux sessions the cleanup page offers to close, and that closing re-checks.
// Run: node scripts/tmux-check.mjs
import { classifyTmux, closeTmux, parsePanes } from "../src/tmux-cleanup.mjs";

const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAILED (${label}): got ${a}, want ${b}`);
    process.exit(1);
  }
};
const NOW = 2_000_000 * 1000;
const T = "\t";
const panes = parsePanes(
  [
    `1${T}0${T}${2_000_000 - 3600}${T}claude${T}/p/portal`,
    `13${T}1${T}${2_000_000 - 60}${T}claude${T}/p/portal`,
    `10${T}0${T}${2_000_000}${T}htop${T}/home/me`,
    `11${T}0${T}${2_000_000 - 99999}${T}bash${T}/p/backend`,
    `12${T}0${T}${2_000_000 - 99999}${T}claude${T}/p/backend`,
    `14${T}0${T}${2_000_000}${T}claude${T}/p/busy`,
    `15${T}0${T}${2_000_000}${T}claude${T}/p/busy`,
    `bad name${T}0${T}${2_000_000}${T}bash${T}/x`,
  ].join("\n")
);
const s = (id, tmux, started, extra = {}) => ({ session_id: id, tmux, pid: started, started, folder: `/p/${id}`, aiTitle: `t-${id}`, ...extra });
const sessions = [
  s("A", "1", 100), s("A", "13", 200), // 1 is an older copy of the session 13 runs
  s("B", "12", 300),                   // only copy of its session
  s("C", "14", 400), s("C", "15", 500, { state: "busy" }), // the older copy's newer twin is working: the old one is still a copy
];
const by = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
const r = by(classifyTmux(panes, sessions, NOW));

eq(r["1"].kind, "copy", "older copy of a live session");
eq(r["1"].closable, true, "…is closable");
eq(r["1"].why, "same session open in tmux 13", "…and says where the live one is");
eq(r["13"].closable, false, "the newest copy is never closable");
eq(r["13"].why, "attached", "an attached session says so");
eq(r["12"].closable, false, "the only copy of a session is never closable");
eq(r["10"].kind, "other", "htop is not Claude");
eq(r["10"].closable, true, "…and is closable");
eq(r["11"].why, "idle shell, nothing running", "an idle shell reads as one");
eq(r["14"].kind, "copy", "an older twin of a working session is still a copy");
eq(r["15"].closable, false, "a working session is never closable");
eq(r["bad name"].closable, false, "an unusual name is never sent to a shell");
eq(classifyTmux(panes, sessions, NOW).map((x) => x.name), ["1", "14", "10", "11", "12", "13", "15", "bad name"], "copies first, then non-Claude, then in use, names in numeric order");

// Attached older copy is in use: somebody is looking at it.
eq(by(classifyTmux(parsePanes(`1${T}2${T}${2_000_000}${T}claude${T}/p`), [s("A", "1", 100), s("A", "9", 200)], NOW))["1"].closable, false, "an attached copy stays");

// Closing re-lists and re-decides: 13 was attached, 1 is fine, 99 is gone, 14 is a copy.
const killed = [];
const out = await closeTmux(["1", "13", "99", "14", "15"], {
  list: async () => panes,
  sessions: () => sessions,
  kill: async (n) => (killed.push(n), true),
});
eq(killed, ["1", "14"], "only what is still closable is closed");
eq(out.map((x) => x.ok), [true, false, false, true, false], "one result per name, in order");
eq(out[2].why, "already gone", "a vanished session says so");

// A host that doesn't answer closes nothing.
eq((await closeTmux(["1"], { list: async () => null, sessions: () => [], kill: async () => { throw new Error("no"); } }))[0].ok, false, "no listing, no kill");

// A session list that shifted since the page was drawn: 1's newer twin is gone.
const k2 = [];
await closeTmux(["1"], { list: async () => panes, sessions: () => [s("A", "1", 100)], kill: async (n) => (k2.push(n), true) });
eq(k2, [], "if the live twin has gone, the old one is now the only copy and stays");
console.log("OK: tmux cleanup classification and re-checked close");
