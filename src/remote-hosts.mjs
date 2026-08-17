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
 * The folders whose keys are missing because their host can't be reached, as
 * `[{ host, folder, since }]` — one per folder, so each lands in the block slot
 * it already held.
 *
 * A failed fetch leaves `source: null`, which `cachedSources` filters out, so
 * the host's keys disappear exactly the way a closed window's do — the two are
 * indistinguishable on a board whose entire job is saying what is true. What
 * makes saying so possible is that a remote window's extension host runs
 * *locally* (`extensionKind: ["ui"]`), so `readWindowStates()` still knows that
 * host's windows and their folders while ssh is dead. The information was
 * always there; it was being discarded.
 *
 * `failures` rather than `source == null`: a host that has never been fetched
 * also has no source, and "not yet" is not "unreachable".
 */
export function unreachableHosts(windows, memo) {
  // Reporting hosts as down while deliberately not fetching them would make
  // the switch a lie, the same reasoning remoteSources applies to its sources.
  if (process.env.STREAMDECK_NO_REMOTE === "1") return [];
  const out = new Map();
  for (const w of windows) {
    if (!w.host) continue;
    const entry = memo.get(w.host);
    if (!entry?.failures) continue;
    // Keyed so a folder open in two windows on one host is one key, not two
    // stacked on the same slot.
    for (const folder of w.folders ?? []) {
      out.set(`${w.host}:${folder}`, { host: w.host, folder, since: entry.failingSince ?? entry.lastAt });
    }
  }
  return [...out.values()];
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
  for (const host of [...memo.keys()]) {
    // Never evict a host with a fetch still running: deleting its entry would
    // take the in-flight claim with it, and a window that closes and reopens
    // mid-fetch — a reload, which this project treats as routine — would then
    // dispatch a second fetch into the same staging directory and ControlPath.
    // Its own completion handler writes the entry back; the next tick evicts it
    // then, if the host is still gone. `cachedSources` filters by this tick's
    // live windows regardless, so a stale entry is never returned meanwhile.
    if (!live.has(host) && !memo.get(host)?.inFlight) memo.delete(host);
  }

  const due = dueHosts(windows, now, memo);
  await Promise.all(
    due.map(async (host) => {
      const previous = memo.get(host) ?? { lastAt: 0, failures: 0, source: null };
      // Claimed before the first await, so a poll landing mid-fetch sees this
      // host as busy rather than starting a second one against the same
      // staging directory.
      memo.set(host, { ...previous, inFlight: true });
      const source = await fetch(host);
      // Stamped on completion, not with the tick's `now` — `dueHosts`' own
      // comment already says lastAt is a finish time, and cadence/backoff both
      // depend on that being true. A `now` stamp instead would leave a fetch
      // slower than REMOTE_POLL_MS due again on the very next tick (no idle
      // gap, the constant load REMOTE_POLL_MS exists to prevent), and would let
      // an unreachable host burn its own 5-15s attempt time out of its backoff
      // window — a 30s backoff paying out in 15-25s, a 5s one in almost none.
      const settledAt = Date.now();
      if (source) {
        if (previous.failures) console.error(`remote ${host}: reachable again`);
        memo.set(host, { lastAt: settledAt, failures: 0, failingSince: null, source, inFlight: false });
      } else {
        if (!previous.failures) console.error(`remote ${host}: unreachable, keys dropped`);
        memo.set(host, {
          lastAt: settledAt,
          failures: previous.failures + 1,
          // Stamped once, at the transition into failure, and never restamped:
          // the key reports how long the host has been gone, and retries are
          // every few seconds. `lastAt` would answer "how long since the last
          // attempt", which is always about zero and says nothing.
          failingSince: previous.failingSince ?? settledAt,
          source: null,
          inFlight: false,
        });
      }
    })
  );

  return cachedSources(windows, memo);
}
