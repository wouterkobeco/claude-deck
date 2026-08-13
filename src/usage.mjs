import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";

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
const TTL_MS = 60_000;

let cache = { at: 0, value: { session: null, week: null, sessionResetsAt: null, weekResetsAt: null } };
let lastError = null;
// The request currently in flight, if any — see getUsage.
let inflight = null;

async function accessToken() {
  const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  return JSON.parse(stdout).claudeAiOauth?.accessToken ?? null;
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

export async function fetchUsage() {
  const token = await accessToken();
  if (!token) throw new Error("no OAuth token in keychain (API-key login?)");
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

/**
 * Cached usage, safe to call on every poll. Failures keep the last good value
 * rather than blanking the key, and are logged once per distinct message so a
 * persistent outage doesn't fill the log.
 */
export async function getUsage(now = Date.now(), fetcher = fetchUsage) {
  if (now - cache.at < TTL_MS) return cache.value;
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
    } catch (err) {
      // A 429 means we have already asked too often; retrying in half a TTL
      // is the opposite of what it is telling us, so it waits the full one.
      // Other failures are more likely transient and keep the short retry.
      const rateLimited = err.message.includes("429");
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
