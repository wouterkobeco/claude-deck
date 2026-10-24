// What Opper actually billed for the ship-review skill's DeepSeek runs.
//
// Opper picks the serving provider per call and the providers price the same
// model differently, so RATES.deepseek is only an estimate. The skill tags each
// run `review:<its temp dir's name>` (X-Opper-Tags), the rollout's cwd sits
// inside that temp dir, and Opper's analytics endpoint sums cost by tag per
// hour — so a run's real cost is a join the log's own rows already support.
//
// The key is the one `opper login` wrote for the Opper CLI; this reads it and
// writes nothing of Opper's. No key, no network, no tagged run: rows keep the
// estimate, which is what they were priced at when first read.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOUR_MS = 3600_000;
export const TAG_KEY = "review";
const CONFIG = join(homedir(), ".opper", "config.json");

/** The run id a rollout's cwd carries: `…/ship-review.XXXXXX.<id>/tree` → `ship-review.XXXXXX.<id>`. */
export const runOf = (cwd) => /(?:^|\/)(ship-review\.[^./]+\.[A-Za-z0-9]+)(?:\/|$)/.exec(cwd ?? "")?.[1] ?? null;

export function opperKey(path = CONFIG) {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    const k = c.keys?.[c.defaultKey];
    return (typeof k === "string" ? k : (k?.apiKey ?? k?.key ?? k?.api_key)) || null;
  } catch {
    return null;
  }
}

/**
 * Cost per (hour, run, model) from `from` on, as `{hour, run, model, cost}`
 * rows, or null when it could not be asked. Never throws: a flaky network must
 * not take the token pass down with it.
 */
export async function fetchRunCosts(from, { key = opperKey(), fetchImpl = fetch } = {}) {
  if (!key) return null;
  const url = new URL("https://api.opper.ai/v2/analytics/usage");
  url.search = new URLSearchParams({ group_by: `${TAG_KEY},model`, granularity: "hour", from_date: new Date(from).toISOString().slice(0, 13) + ":00:00Z" });
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.flatMap((r) => (r[TAG_KEY] && Number.isFinite(Date.parse(r.time_bucket)) ? [{ hour: Date.parse(r.time_bucket), run: r[TAG_KEY], model: r.model ?? "", cost: Number(r.cost) || 0 }] : []));
  } catch {
    return null;
  }
}

const weight = (r) => (r.in ?? 0) + (r.out ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);

/**
 * Replace the estimate on `records` (codex-deepseek rows) with Opper's figure.
 * Rows of one (hour, run) share that run's real cost in proportion to their
 * tokens, and take the model of the costliest serving model. Returns how many
 * rows changed; rows with no tag, or no figure yet, are left alone.
 */
export function applyRunCosts(records, costs) {
  const byRun = new Map();
  for (const c of costs) {
    const k = `${c.hour}|${c.run}`;
    const e = byRun.get(k) ?? { cost: 0, model: "", top: -1 };
    e.cost += c.cost;
    if (c.cost > e.top) [e.model, e.top] = [c.model, c.cost];
    byRun.set(k, e);
  }
  const groups = new Map();
  for (const r of records) {
    const run = runOf(r.cwd);
    if (r.provider !== "codex-deepseek" || !run || !byRun.has(`${r.hour}|${run}`)) continue;
    const k = `${r.hour}|${run}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let changed = 0;
  for (const [k, rows] of groups) {
    const { cost, model } = byRun.get(k);
    const total = rows.reduce((s, r) => s + weight(r), 0);
    for (const r of rows) {
      const share = total ? (cost * weight(r)) / total : cost / rows.length;
      if (r.exact && r.model === model && Math.abs(r.costUsd - share) < 1e-12) continue;
      Object.assign(r, { costUsd: share, model, exact: true });
      changed++;
    }
  }
  return changed;
}

export const SETTLE_MS = 48 * HOUR_MS;
