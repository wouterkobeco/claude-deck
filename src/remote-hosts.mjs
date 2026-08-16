/**
 * Which hosts to fetch on this tick, and the cached sources for the rest.
 *
 * **Remote hosts poll slower than local.** The main loop runs every 2s because
 * a local read is a few file reads; a remote fetch is two SSH round trips plus a
 * held ControlPersist connection against a machine doing its own work — here, a
 * Raspberry Pi running home automation. Nothing on a remote key changes faster
 * than it can be read, so the slower cadence costs nothing visible.
 *
 * Backoff is the shape `usage.mjs` already uses for 429s: each consecutive
 * failure waits longer, one success drops back to the plain interval.
 */
const REMOTE_POLL_MS = 6000;
const BACKOFF_MS = [5000, 10000, 30000];

function waitFor(entry) {
  if (!entry.failures) return REMOTE_POLL_MS;
  return BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length) - 1];
}

export function dueHosts(windows, now, memo) {
  // Every other reader here degrades to nothing by itself; this one holds an
  // open connection to another machine, so it gets a way to be switched off
  // without killing the daemon.
  if (process.env.STREAMDECK_NO_REMOTE === "1") return [];
  const hosts = [...new Set(windows.map((w) => w.host).filter(Boolean))];
  return hosts.filter((h) => {
    const entry = memo.get(h);
    if (!entry) return true;
    // A fetch already running is not due again. `lastAt` alone cannot say this:
    // it is stamped when a fetch *finishes*, so a slow one stays due for its
    // whole duration. That window is not theoretical — a hanging host runs to
    // the 15s hard kill against a 6s interval — and two overlapping fetches for
    // one host share a staging directory and a ControlPath, so their tar
    // extractions interleave into the same tree.
    if (entry.inFlight) return false;
    return now - entry.lastAt >= waitFor(entry);
  });
}

/**
 * The sources currently cached for this tick's live hosts — no fetch, no
 * await, just what the last successful fetch (if any) left in `memo`. This is
 * what the poll loop actually reads every 2s: `remoteSources` computes the
 * same list after doing the fetching, so there is exactly one definition of
 * "the current sources".
 */
export function cachedSources(windows, memo) {
  const live = new Set(windows.map((w) => w.host).filter(Boolean));
  return [...live].map((h) => memo.get(h)?.source).filter(Boolean);
}

/**
 * Fetch what is due, keep what is not, and drop a host whose window has closed.
 *
 * A failing host's keys vanish the way a closed window's do, and the transition
 * is logged once rather than every poll — a line per 6s for a sleeping Pi is a
 * log nobody reads.
 */
export async function remoteSources(windows, now, memo, fetch) {
  // Same switch dueHosts already honours for new fetches; without this a
  // source fetched before the flag was set would keep being returned here,
  // which is unreachable today (nothing mutates a running process's env) but
  // would otherwise make the switch a lie at this level.
  if (process.env.STREAMDECK_NO_REMOTE === "1") return [];

  const live = new Set(windows.map((w) => w.host).filter(Boolean));
  for (const host of [...memo.keys()]) if (!live.has(host)) memo.delete(host);

  const due = dueHosts(windows, now, memo);
  await Promise.all(
    due.map(async (host) => {
      const previous = memo.get(host) ?? { lastAt: 0, failures: 0, source: null };
      // Claimed before the first await, so a poll landing mid-fetch sees this
      // host as busy rather than starting a second one against the same
      // staging directory.
      memo.set(host, { ...previous, inFlight: true });
      const source = await fetch(host);
      if (source) {
        if (previous.failures) console.error(`remote ${host}: reachable again`);
        memo.set(host, { lastAt: now, failures: 0, source, inFlight: false });
      } else {
        if (!previous.failures) console.error(`remote ${host}: unreachable, keys dropped`);
        memo.set(host, { lastAt: now, failures: previous.failures + 1, source: null, inFlight: false });
      }
    })
  );

  return cachedSources(windows, memo);
}
