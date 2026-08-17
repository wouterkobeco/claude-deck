// Which colour each project wore last time.
//
// The accent bar is the board's only "which project is this?" signal, and
// until this file existed it was re-picked from scratch every start: the map
// lived for the daemon's lifetime and nothing outlived a restart, so the
// colour a project wore was whatever `readdir` order handed it that morning.
// Muscle memory for where a button is survives a restart (folderOrder rebuilds
// in the same first-seen way); muscle memory for what colour it wears did not.
//
// This is the daemon's third write into ~/.claude and the first that is its
// own memory rather than a message to another process — the other two are read
// by the extension, this one only by the next run of this file. It is
// deliberately not a config file: nothing here is meant to be hand-edited, and
// a value nobody typed can always be thrown away.
//
// Best-effort in the same way as vscode-state.mjs and terminal-focus.mjs: a
// missing, unreadable or corrupt file is a first run, and a failed write is a
// restart that forgets. Never throw — the board must draw either way.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const fileIn = (root) => join(root, "streamdeck-accents.json");

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
//
// Lives here rather than in index.mjs because config-server.mjs needs the
// palette and index.mjs needs openConfig from config-server.mjs — one of those
// edges has to not exist. index.mjs re-exports it, so colors-check and
// slots-check import it from there unchanged.
export const ACCENTS = ["#4fc3f7", "#ff8a65", "#ba68c8", "#fff176", "#4db6ac", "#f06292", "#aed581", "#bcaaa4"];

/**
 * Everything remembered about each project: its accent, and where it sits.
 *
 * Returns `{ accents: Map<folderKey, hex>, order: folderKey[] }`. Keyed by
 * `folderKeyFor`'s value, not a bare path, so the same path on two hosts
 * remembers two of each — the board already treats those as two projects and
 * the file has to agree.
 *
 * **A string value is the old shape**, from before the config page could
 * reorder: `{"<key>": "#4fc3f7"}` rather than `{"<key>": {accent, order}}`.
 * It is read as an accent with no position, so the colours already on disk
 * when this shipped survive rather than being silently dropped and re-picked.
 *
 * `root` is a parameter rather than a constant so the check can point it at a
 * fixture, the shape sessions.mjs already uses for CLAUDE_DIR.
 */
export function readProjects(root = CLAUDE_DIR) {
  const accents = new Map();
  const positioned = [];
  try {
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(fileIn(root), "utf8")))) {
      // A hand-edited or half-written file must not put a non-string into the
      // SVG: render.mjs drops whatever it is straight into a fill attribute.
      const accent = typeof value === "string" ? value : value?.accent;
      if (typeof accent === "string") accents.set(key, accent);
      if (typeof value?.order === "number") positioned.push([key, value.order]);
    }
  } catch {
    return { accents: new Map(), order: [] };
  }
  // Sorted rather than trusted: the numbers are only ever this module's own
  // array indices, but nothing stops a hand-edited file holding gaps, ties or
  // negatives, and the array is what everything downstream reads.
  return { accents, order: positioned.sort((a, b) => a[1] - b[1]).map(([key]) => key) };
}

export function writeProjects(accents, order, root = CLAUDE_DIR) {
  try {
    const at = new Map(order.map((key, i) => [key, i]));
    const out = {};
    // Union of both, so a project that has one and not the other still gets a
    // record — a colour claimed on a poll where assignSlots hasn't run yet,
    // or a position for something whose accent was evicted by a swap.
    for (const key of new Set([...accents.keys(), ...order])) {
      out[key] = { accent: accents.get(key), order: at.get(key) };
    }
    writeFileSync(fileIn(root), JSON.stringify(out, null, 2));
  } catch {
    // A restart that forgets, which is what every restart did before this.
  }
}

/**
 * Move `folder` to sit immediately before `before`, or to the end when
 * `before` is null. Mutates `order` in place, and is a no-op for a key it
 * doesn't hold.
 *
 * Pure and here rather than in index.mjs for the same reason
 * `applyAccentChoice` is: the persisting caller writes the real ~/.claude file
 * with no root argument, so a check that drove it would clobber this machine's
 * remembered order with fixture folders.
 *
 * The removal happens before the target is located, so dragging a row past
 * itself can't land it one position off — the classic splice bug, and the one
 * thing here that a check catches and a glance at the code does not.
 */
export function moveProject(order, folder, before) {
  const from = order.indexOf(folder);
  if (from === -1) return;
  order.splice(from, 1);
  const to = before === null || before === undefined ? -1 : order.indexOf(before);
  if (to === -1) order.push(folder);
  else order.splice(to, 0, folder);
}

/**
 * Give `folder` the colour `accent`, keeping "no two live folders share one".
 *
 * Pure, and parameterised rather than reaching for a module-level map, because
 * the persisting caller lives in index.mjs and writes the real ~/.claude file
 * — see `persistAccents`' comment there. A check drives this; nothing drives
 * that.
 *
 * A *live* folder wearing that colour trades: it takes what `folder` gave up,
 * so the swap is closed and `assignSlots`' collision rule never has to fire on
 * a hand-made choice. A *closed* one is dropped instead of traded — handing a
 * colour to something that isn't on the board is invisible, and leaving the
 * duplicate in the file means that folder's return is resolved by iteration
 * order, which is effectively readdir order and would silently take a
 * deliberate choice back days later.
 *
 * `folder` having no previous colour can't arise from the UI — every live
 * folder has one by the time it is listed — but is handled like a closed owner
 * rather than left to create a duplicate.
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
