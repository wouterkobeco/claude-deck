import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Set USAGE_LOG=1 (or to a path) to append one line per request to a jsonl
// file: when it went out, how long since the previous one, what came back, and
// the response headers — the endpoint is shared with every other client using
// the same token, so "are we asking too often" can only be answered by looking
// at the gaps and at what the server says alongside a 429.
const LOG_PATH =
  process.env.USAGE_LOG === "1" ? `${homedir()}/.claude/streamdeck-usage.jsonl` : process.env.USAGE_LOG || null;
let lastRequestAt = null;

async function logRequest(record) {
  if (!LOG_PATH) return;
  try {
    // How many Claude Code sessions are alive right now: they poll this same
    // endpoint with this same token, so a 429 that lands only when many are
    // running says the quota is shared, not that the daemon is spinning.
    const sessions = await readdir(`${homedir()}/.claude/sessions`).catch(() => []);
    await appendFile(LOG_PATH, JSON.stringify({ ...record, sessions: sessions.length }) + "\n");
  } catch {
    // Instrumentation must never take the daemon down with it.
  }
}

// The same numbers Claude Code's /usage shows. There is no local cache of them
// — they only exist server-side — so this asks the API with the subscription's
// OAuth token, the one the CLI itself stores in the login keychain.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Five minutes, not one: these are 5-hour and 7-day windows, so a minute's
// resolution buys nothing, and the endpoint is shared with every Claude Code
// session on the machine — measured, a well-behaved 1/min client still lost
// 19% of its requests to 429s it wasn't causing.
export const TTL_MS = 300_000;
// A 429 carries no retry-after worth reading (the endpoint answers `0`) and no
// ratelimit headers at all, so backing off is guesswork: wait a TTL longer each
// consecutive time, up to half an hour, and drop back to the plain TTL on the
// first success.
const MAX_BACKOFF_MS = 1_800_000;

let cache = { at: 0, value: { session: null, week: null, sessionResetsAt: null, weekResetsAt: null } };
let lastError = null;
let backoffMs = 0;
// The request currently in flight, if any — see getUsage.
let inflight = null;
// undefined = not read yet (first read is discovery, not a switch); a string
// once read, so the very next fetch that reads something else is a change.
let lastSubscription;

async function credentials() {
  const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  const oauth = JSON.parse(stdout).claudeAiOauth ?? {};
  return { accessToken: oauth.accessToken ?? null, subscriptionType: oauth.subscriptionType ?? null, rateLimitTier: oauth.rateLimitTier ?? null };
}

/**
 * The keychain carries which plan the token belongs to alongside the token
 * itself, so this rides fetchUsage's own cadence (its TTL/backoff) rather
 * than a timer of its own — "checked at an interval" for free. Pure so it can
 * be checked without touching the keychain; the state it compares against
 * lives in the one caller.
 */
export function subscriptionChange(prev, subscriptionType, rateLimitTier) {
  const key = `${subscriptionType ?? "?"}/${rateLimitTier ?? "?"}`;
  return { key, message: prev !== undefined && prev !== key ? `usage: subscription changed (${prev} -> ${key})` : null };
}

// Not in the keychain credentials read above — the CLI's own config carries
// it instead, in ~/.claude.json (outside ~/.claude/, the one other config
// file this project reads from). Cached on the same 5-minute TTL as usage:
// it changes only on a login switch, and that file is 100+KB of unrelated
// project/session state to reparse on every page load.
const ACCOUNT_PATH = join(homedir(), ".claude.json");
let accountCache = { at: 0, value: null };

/** The signed-in account's display name (falling back to its email), or null — best-effort, like every other file read here. */
export async function getAccountName(now = Date.now()) {
  if (now - accountCache.at < TTL_MS) return accountCache.value;
  try {
    const acct = JSON.parse(await readFile(ACCOUNT_PATH, "utf8"))?.oauthAccount ?? {};
    accountCache = { at: now, value: acct.displayName || acct.emailAddress || null };
  } catch {
    accountCache = { ...accountCache, at: now };
  }
  return accountCache.value;
}

/** Raw response → the two percentages the key shows, plus when each window turns over. */
export function parseUsage(json) {
  const pct = (w) => (typeof w?.utilization === "number" ? w.utilization : null);
  return {
    session: pct(json?.five_hour),
    week: pct(json?.seven_day),
    sessionResetsAt: json?.five_hour?.resets_at ?? null,
    weekResetsAt: json?.seven_day?.resets_at ?? null,
  };
}

/** An ISO timestamp -> whole units remaining until it, floored at 0 for an already-passed reset. */
function until(iso, unitMs, now) {
  if (!iso) return null;
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / unitMs));
}

export const daysUntil = (iso, now = Date.now()) => until(iso, 86_400_000, now);
export const hoursUntil = (iso, now = Date.now()) => until(iso, 3_600_000, now);
export const minutesUntil = (iso, now = Date.now()) => until(iso, 60_000, now);

// The reset tiles' text: coarse unit ("hours" for the 5h window, "days" for
// the 7d one) until under an hour is left, where "0h" stops being honest and
// minutes take over. Null through to the caller's own placeholder.
export function formatReset(iso, unit, now = Date.now()) {
  if (!iso) return null;
  const minutes = minutesUntil(iso, now);
  if (minutes < 60) return `${minutes}m`;
  if (unit === "hours") return `${hoursUntil(iso, now)}h`;
  // "days" drops to the finer unit under a day, the same reason "hours" drops
  // to minutes under an hour: `daysUntil` ceils, so 1h and 23h both read "1d"
  // otherwise — honest about "resets today" but not about how soon.
  const hours = hoursUntil(iso, now);
  return hours < 24 ? `${hours}h` : `${daysUntil(iso, now)}d`;
}

export async function fetchUsage() {
  const { accessToken: token, subscriptionType, rateLimitTier } = await credentials();
  if (!token) throw new Error("no OAuth token in keychain (API-key login?)");
  const { key, message } = subscriptionChange(lastSubscription, subscriptionType, rateLimitTier);
  if (message) console.error(message);
  lastSubscription = key;
  const at = Date.now();
  const sincePrevMs = lastRequestAt === null ? null : at - lastRequestAt;
  lastRequestAt = at;
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    await logRequest({
      at: new Date(at).toISOString(),
      sincePrevMs,
      tookMs: Date.now() - at,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: body.slice(0, 500),
    });
    throw new Error(`usage endpoint returned ${res.status}`);
  }
  await logRequest({
    at: new Date(at).toISOString(),
    sincePrevMs,
    tookMs: Date.now() - at,
    status: res.status,
    headers: Object.fromEntries(res.headers),
  });
  return res.json();
}

// A short, one-way fingerprint of the access token — cheap to compare and
// never itself exposed, the way cswap's own `credential_fingerprint` isn't
// either. `subscriptionChange`'s type/tier pair isn't enough to catch a
// switch on its own: two accounts on the same plan (two Max subscriptions,
// say) share both fields, and a switch between them would go unnoticed.
const fingerprint = (token) => (token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : null);

let lastFingerprint;
let identityCheckAt = 0;
let identityInflight = null;

// Test-only: usage-check drives the identity watch with a fake credentialsFn
// against deterministic timestamps, which only means something starting from
// a known state — the module's own singleton state otherwise carries over
// from whatever the real keychain looked like during an earlier test in the
// same run.
export function _resetIdentityWatchForTests() {
  lastFingerprint = undefined;
  identityCheckAt = 0;
  // A real identityInflight from an earlier test's default (unmocked)
  // credentials() call can still be pending here — a subprocess spawn takes
  // longer than a microtask flush — and `watchIdentity`'s own guard would
  // otherwise skip every check in this test until it eventually settles on
  // its own schedule. Discarding the reference doesn't cancel the subprocess,
  // but nothing here still cares what it resolves to.
  identityInflight = null;
}
// A local keychain read, no network — cheap enough to poll far more often
// than the 5-minute usage TTL, so a `cswap switch` (or any credential
// rewrite) is caught within seconds rather than sitting under the old
// account's numbers for the rest of the TTL window.
const IDENTITY_CHECK_MS = 10_000;

/**
 * Watches the keychain credential itself for a change, independent of and
 * far more often than `getUsage`'s own TTL — a switch changes the token the
 * instant it's written, but the cached *numbers* have no way to know that on
 * their own. Never awaited from `getUsage`'s synchronous path: a keychain
 * read is local but not guaranteed instant (contention, a machine already
 * under load), and trading a stale-for-one-more-poll account for a stalled
 * poll every 2s would be the wrong swap. On a change it resets `cache.at` to
 * 0 — not the value itself, which stays until the next `getUsage()` call
 * actually resolves the real fetch that `cache.at = 0` triggers.
 */
function watchIdentity(now, credentialsFn) {
  if (now - identityCheckAt < IDENTITY_CHECK_MS || identityInflight) return;
  identityCheckAt = now;
  identityInflight = credentialsFn()
    .then(({ accessToken }) => {
      const fp = fingerprint(accessToken);
      // undefined on the very first check: that's discovery, not a switch.
      if (lastFingerprint !== undefined && fp !== lastFingerprint) {
        console.error("usage: keychain credential changed, forcing a refresh");
        cache = { ...cache, at: 0 };
        backoffMs = 0; // a new account's rate-limit history isn't the old one's
      }
      lastFingerprint = fp;
    })
    .catch(() => {
      // Best-effort, like every other read here — a failed check just tries
      // again on the next tick.
    })
    .finally(() => {
      identityInflight = null;
    });
}

/**
 * Cached usage, safe to call on every poll. Failures keep the last good value
 * rather than blanking the key, and are logged once per distinct message so a
 * persistent outage doesn't fill the log.
 */
export async function getUsage(now = Date.now(), fetcher = fetchUsage, credentialsFn = credentials) {
  watchIdentity(now, credentialsFn);
  if (now - cache.at < TTL_MS + backoffMs) return cache.value;
  // `cache.at` isn't written until the fetch resolves, so without this a
  // request still in flight looks exactly like no request at all and the next
  // 2s poll starts another one. A single slow response then becomes a request
  // every poll — which is how this endpoint starts answering 429, and once it
  // does, every one of those in-flight retries fails together. Concurrent
  // callers share the one request instead.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      cache = { at: Date.now(), value: parseUsage(await fetcher()) };
      lastError = null;
      backoffMs = 0;
    } catch (err) {
      // A 429 means we have already asked too often; retrying sooner is the
      // opposite of what it is telling us, so each consecutive one waits a TTL
      // longer than the last. Other failures are more likely transient and keep
      // the short retry, and leave the backoff alone — a network blip is not
      // the server asking for room.
      const rateLimited = err.message.includes("429");
      if (rateLimited) backoffMs = Math.min(backoffMs ? backoffMs * 2 : TTL_MS, MAX_BACKOFF_MS);
      cache = { ...cache, at: rateLimited ? Date.now() : Date.now() - TTL_MS / 2 };
      if (err.message !== lastError) {
        console.error("usage lookup failed:", err.message);
        lastError = err.message;
      }
    }
    return cache.value;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
