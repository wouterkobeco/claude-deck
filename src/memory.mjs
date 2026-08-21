import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TTL_MS = 5_000;

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

let cache = { at: 0, value: { pressure: null, swap: null } };

/** Cached 5s, safe on every poll; any failure reads as unknown. */
export async function getMemory(now = Date.now()) {
  if (now - cache.at < TTL_MS) return cache.value;
  let value = cache.value;
  try {
    const { stdout } = await run("sysctl", ["-n", "kern.memorystatus_level", "vm.swapusage"]);
    const [level, swap] = stdout.trim().split("\n");
    value = parseMemory(level, swap);
  } catch {}
  cache = { at: now, value };
  return value;
}
