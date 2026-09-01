import { execFile } from "node:child_process";
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

// cswap only refreshes when it runs, so a cached window whose reset time has
// already passed is for a window that no longer exists — repeating its
// percentage would be dishonest, and the daemon holds no credential to ask
// for the real number. Unknown beats wrong. A window with no resets_at at
// all can't be judged and is kept as-is.
const window_ = (w, now) =>
  w?.resets_at && Date.parse(w.resets_at) <= now
    ? { pct: null, resetsAt: null }
    : { pct: pct(w), resetsAt: w?.resets_at ?? null };

/** `sequence.json` + `cache/usage.json` -> one entry per account, in slot order. */
export function parseCswap(sequence, usage, now = Date.now()) {
  const active = String(sequence?.activeAccountNumber ?? "");
  return Object.entries(sequence?.accounts ?? {})
    // Active first — it's the one the usage key already describes, so it
    // leads everywhere it's listed — then slot order.
    .sort(([a], [b]) => (b === active) - (a === active) || Number(a) - Number(b))
    .map(([slot, acct]) => {
      const good = usage?.accounts?.[slot]?.lastGood ?? {};
      const email = typeof acct?.email === "string" ? acct.email : `slot ${slot}`;
      const session = window_(good.five_hour, now);
      const week = window_(good.seven_day, now);
      return {
        slot,
        email,
        name: email.split("@")[0],
        active: slot === active,
        session: session.pct,
        week: week.pct,
        sessionResetsAt: session.resetsAt,
        weekResetsAt: week.resetsAt,
      };
    });
}

// cswap refreshes its cache only when something runs it, so left alone the
// inactive accounts' numbers age until a window they describe no longer
// exists. Rather than repeat that (the expired-window guard above) or hold
// the other accounts' credentials (never — that's cswap's job, and rotating
// a refresh token behind its back can invalidate what it restores), the
// daemon runs `cswap list` when the cache is provably behind: the newest
// fetch is over an hour old, or a cached window's reset has already passed.
const REFRESH_MS = 3_600_000;
// The endpoint behind cswap 429s freely (see usage.mjs), and `cswap list`
// asks it once per account — never sooner than this after any attempt,
// landed or failed, including "cswap isn't installed".
const COOLDOWN_MS = 600_000;

export function needsRefresh(usage, now) {
  const accounts = Object.values(usage?.accounts ?? {});
  if (!accounts.length) return false;
  const newest = Math.max(...accounts.map((a) => (a.fetchedAt ?? 0) * 1000));
  if (now - newest > REFRESH_MS) return true;
  return accounts.some((a) =>
    [a.lastGood?.five_hour, a.lastGood?.seven_day].some(
      (w) => w?.resets_at && Date.parse(w.resets_at) <= now
    )
  );
}

const runCswapList = (done) => execFile("cswap", ["list"], { timeout: 30_000 }, () => done());

let refresh = { inFlight: false, lastAttempt: 0 };

/** Fire-and-forget — the poll never waits on cswap. Returns whether it fired. */
export function maybeRefreshCswap(usage, now, run = runCswapList) {
  if (!needsRefresh(usage, now)) return false;
  if (refresh.inFlight || now - refresh.lastAttempt < COOLDOWN_MS) return false;
  refresh = { inFlight: true, lastAttempt: now };
  run(() => { refresh.inFlight = false; });
  return true;
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
    value = parseCswap(sequence, usage, now);
    maybeRefreshCswap(usage, now);
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
