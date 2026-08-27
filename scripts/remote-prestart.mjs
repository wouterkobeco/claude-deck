// `npm start`'s fourth prestart: check every currently-open remote host for
// the same two optional installs the local prestarts offer — the compaction
// hooks and the status line — since a Remote-SSH window's host is exactly as
// blind to either as this machine would be without them, and nothing
// currently ever tells you that.
//
// Same contract as the other three: silent when there is nothing to do, one
// line when there is nobody to ask, every path exits 0. **Never blocks on a
// dead host** — this project's own Pi is home-automation gear that is
// routinely off, and `npm start` running every session must not learn to
// wait on it. A host that can't answer within PROBE_TIMEOUT_MS is treated
// exactly like an unreachable one is everywhere else in this project:
// skipped, not warned about.
import { createInterface } from "node:readline/promises";
import { readWindowStates } from "../src/window-state.mjs";
import { applyCompactHook, applyStatusLine, probeCompactHook, probeStatusLine } from "./remote-install.mjs";

// Short and strict, unlike remote-install.mjs's own 30s default: this probe
// runs on the critical path of every `npm start`, not a command someone typed
// once and is willing to wait on.
const PROBE_TIMEOUT_MS = 5000;

// Already `validHost`-checked inside readWindowStates() itself (a window's
// published `host` is `validHost(state.host)`, the same guard the CLI runs on
// its own argv), and every ssh call this makes goes through remote-fs.mjs's
// shared `sshArgs`, which places `--` before the host in argv — so there is
// no second validation to do here, and no separate argv construction that
// could have missed it.
const hosts = [...new Set(readWindowStates().map((w) => w.host).filter(Boolean))];
if (!hosts.length) process.exit(0);

// All hosts probed together — a slow or dead one must not delay the others,
// and this is read-only, so there is nothing sequential about it. Any
// rejection (timeout, unreachable, ssh failure) reads as "unreachable" and is
// dropped silently below, the same as a host the daemon's own poll can't
// reach.
const results = await Promise.all(
  hosts.map(async (host) => {
    const [compactHook, statusLine] = await Promise.all([
      probeCompactHook(host, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => ({ action: "unreachable" })),
      probeStatusLine(host, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => ({ action: "unreachable" })),
    ]);
    return { host, compactHook, statusLine };
  })
);

// `--yes` is what `npm run remote-prestart:install` (if ever wired up) would
// pass; today nothing does, since forcing this across every host with no
// question asked is a bigger step than the local `--yes` flags take.
const forced = process.argv.includes("--yes");
const interactive = forced || process.stdin.isTTY;
const rl = interactive && !forced ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q) =>
  forced
    ? "y"
    : await rl
        .question(q)
        .then((a) => a.trim().toLowerCase())
        .catch(() => "n"); // EOF rejects rather than "" — treat it as no, same as the other prestarts

for (const { host, compactHook, statusLine } of results) {
  if (compactHook.action === "unparseable") {
    console.log(`${host}: settings.json isn't valid JSON — skipping its compaction hooks. Fix it, then run 'npm run remote:install -- ${host}'.`);
  } else if (compactHook.action === "install") {
    if (!interactive) {
      console.log(`${host}: missing the PreCompact/PostCompact hooks — an auto-triggered compaction won't show there. run 'npm run remote:install -- ${host}' to add them`);
    } else {
      const a = await ask(`${host}: add the PreCompact/PostCompact hooks, so an auto-triggered compaction shows there too? [Y/n] `);
      if (a !== "n" && a !== "no") {
        try {
          await applyCompactHook(host, compactHook.settings);
          console.log(`${host}: PreCompact/PostCompact hooks installed.`);
        } catch (err) {
          console.log(`${host}: couldn't install the hooks (${err.message}).`);
        }
      }
    }
  }
  // "has-script"/"has-key"/"ok"/"unreachable" all mean nothing to offer —
  // unlike the CLI command, this runs on every launch, and repeating "you
  // already have a status line" or "that host is asleep" forever is exactly
  // the noise a prestart must not become.

  if (statusLine.action === "nojq") {
    console.log(`${host}: no jq — its status line block needs it. Install jq there, then run 'npm run remote:install -- ${host}' for the context gauge.`);
  } else if (statusLine.action === "install") {
    if (!interactive) {
      console.log(`${host}: no status line, so no context gauge for sessions there. run 'npm run remote:install -- ${host}' to add one`);
    } else {
      const a = await ask(`${host}: add a status line, so its sessions get a context gauge? [Y/n] `);
      if (a !== "n" && a !== "no") {
        try {
          const result = await applyStatusLine(host);
          if (result.ok) console.log(`${host}: status line installed from ${result.source}.`);
          else console.log(`${host}: no context gauge for now — this machine's own status line has no ctx block to copy. Add it locally first (see README), then run 'npm run remote:install -- ${host}'.`);
        } catch (err) {
          console.log(`${host}: couldn't install a status line (${err.message}).`);
        }
      }
    }
  }
}

rl?.close();
