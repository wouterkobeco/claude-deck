import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// claude-swap (`cswap`) keeps every registered subscription's usage in its own
// cache — it polls the same /api/oauth/usage endpoint usage.mjs does, once per
// stored token, so the inactive accounts' numbers are already on disk and cost
// no network call and no second credential here. Both files are another
// tool's format; any failure reads as "cswap isn't here" and yields [].
export const CSWAP_ROOT = join(homedir(), ".claude-swap-backup");
const TTL_MS = 30_000;

const pct = (w) => (typeof w?.pct === "number" ? w.pct : null);

/** `sequence.json` + `cache/usage.json` -> one entry per account, in slot order. */
export function parseCswap(sequence, usage) {
  const active = String(sequence?.activeAccountNumber ?? "");
  return Object.entries(sequence?.accounts ?? {})
    // Active first — it's the one the usage key already describes, so it
    // leads everywhere it's listed — then slot order.
    .sort(([a], [b]) => (b === active) - (a === active) || Number(a) - Number(b))
    .map(([slot, acct]) => {
      const good = usage?.accounts?.[slot]?.lastGood ?? {};
      const email = typeof acct?.email === "string" ? acct.email : `slot ${slot}`;
      return {
        slot,
        email,
        name: email.split("@")[0],
        active: slot === active,
        session: pct(good.five_hour),
        week: pct(good.seven_day),
        sessionResetsAt: good.five_hour?.resets_at ?? null,
        weekResetsAt: good.seven_day?.resets_at ?? null,
      };
    });
}

let cache = { at: 0, value: [] };

/** Cached, safe on every poll. Missing or unreadable files are an empty list. */
export async function getCswapAccounts(now = Date.now(), root = CSWAP_ROOT) {
  if (now - cache.at < TTL_MS) return cache.value;
  let value = [];
  try {
    const sequence = JSON.parse(await readFile(join(root, "sequence.json"), "utf8"));
    let usage = null;
    try { usage = JSON.parse(await readFile(join(root, "cache", "usage.json"), "utf8")); } catch {}
    value = parseCswap(sequence, usage);
  } catch {}
  cache = { at: now, value };
  return value;
}

// cswap refreshes its cache on its own schedule — or not at all, when nothing
// of it is running — while the daemon already asks the API about the active
// subscription every five minutes. Let that answer win for the active account:
// a live number over a cached one, and a cached one over nothing.
export function withLiveUsage(accounts, live) {
  return accounts.map((a) =>
    a.active
      ? {
          ...a,
          session: live.session ?? a.session,
          week: live.week ?? a.week,
          sessionResetsAt: live.sessionResetsAt ?? a.sessionResetsAt,
          weekResetsAt: live.weekResetsAt ?? a.weekResetsAt,
        }
      : a
  );
}
