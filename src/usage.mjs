import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// The same numbers Claude Code's /usage shows. There is no local cache of them
// — they only exist server-side — so this asks the API with the subscription's
// OAuth token, the one the CLI itself stores in the login keychain.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TTL_MS = 60_000;

let cache = { at: 0, value: { session: null, week: null } };
let lastError = null;

async function accessToken() {
  const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  return JSON.parse(stdout).claudeAiOauth?.accessToken ?? null;
}

/** Raw response → the two percentages the key shows. */
export function parseUsage(json) {
  const pct = (w) => (typeof w?.utilization === "number" ? w.utilization : null);
  return { session: pct(json?.five_hour), week: pct(json?.seven_day) };
}

export async function fetchUsage() {
  const token = await accessToken();
  if (!token) throw new Error("no OAuth token in keychain (API-key login?)");
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  return res.json();
}

/**
 * Cached usage, safe to call on every poll. Failures keep the last good value
 * rather than blanking the key, and are logged once per distinct message so a
 * persistent outage doesn't fill the log.
 */
export async function getUsage(now = Date.now()) {
  if (now - cache.at < TTL_MS) return cache.value;
  try {
    cache = { at: now, value: parseUsage(await fetchUsage()) };
    lastError = null;
  } catch (err) {
    // Hold `at` back only a little so a transient failure retries soon.
    cache = { ...cache, at: now - TTL_MS / 2 };
    if (err.message !== lastError) {
      console.error("usage lookup failed:", err.message);
      lastError = err.message;
    }
  }
  return cache.value;
}
