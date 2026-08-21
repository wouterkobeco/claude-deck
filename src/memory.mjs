import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TTL_MS = 10_000;

// macOS only, like the rest. `kern.memorystatus_level` is the kernel's own
// "free percentage" — what Activity Monitor's pressure graph is derived from —
// so 100 minus it is pressure; `vm.swapusage` is "total = 2048.00M used =
// 1100.00M free = ...". Node's os.freemem() is useless here: macOS keeps
// nearly everything as cache, so it reads near zero on a healthy machine.
export function parseMemory(levelLine, swapLine) {
  const level = /^\d+$/.test(String(levelLine).trim()) ? Number(levelLine) : NaN;
  const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(swapLine ?? "");
  const total = m ? Number(m[1]) : 0;
  return {
    pressure: Number.isFinite(level) ? 100 - level : null,
    swap: m && total > 0 ? (Number(m[2]) / total) * 100 : null,
  };
}

/** `ps -axo rss=,comm=` -> resident MB and count of `claude` CLI processes. */
export function parseClaudeRss(psOut) {
  let kb = 0;
  let count = 0;
  for (const line of String(psOut ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || m[2].split("/").pop() !== "claude") continue;
    kb += Number(m[1]);
    count++;
  }
  return { mb: Math.round(kb / 1024), count };
}

let cache = { at: 0, value: { pressure: null, swap: null, claude: null } };
let inflight = null;

/**
 * Never awaited on the poll's path: it answers from the last reading and
 * refreshes behind itself. `sysctl` is a process spawn, and on the machine
 * this exists to warn about — one deep into swap — a spawn measured 800ms,
 * which inline stalled a third of the deck's ticks. Any failure keeps the
 * last value; a first call answers unknown.
 */
export function getMemory(now = Date.now()) {
  if (now - cache.at >= TTL_MS && !inflight) {
    inflight = Promise.all([
      run("sysctl", ["-n", "kern.memorystatus_level", "vm.swapusage"]),
      // What the Claude sessions themselves hold, resident only — the part
      // swapped out is invisible to ps, so this is a floor, not the bill.
      run("ps", ["-axo", "rss=,comm="]).catch(() => null),
    ])
      .then(([{ stdout }, ps]) => {
        const [level, swap] = stdout.trim().split("\n");
        cache = { at: Date.now(), value: { ...parseMemory(level, swap), claude: ps ? parseClaudeRss(ps.stdout) : null } };
      })
      .catch(() => { cache = { ...cache, at: Date.now() }; })
      .finally(() => { inflight = null; });
  }
  return cache.value;
}
