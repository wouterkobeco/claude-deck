// Which of a remote host's tmux sessions are safe to close, and what closing
// one means. Pure — the ssh listing and the kill are injected, so a check can
// drive every branch without a host.
//
// Why this exists: a Claude session resumed into a second tmux pane (restore,
// a bare `--resume`) leaves the old process running. Two processes now hold one
// session id; the board follows the newer, so the older is invisible while it
// keeps the conversation open twice. Nothing else ever closes them.

// `\t`, not a space: a pane's cwd can hold one. The path is last for the same
// reason — it is the only field that can.
export const PANES_CMD =
  "tmux list-panes -a -F '#{session_name}\t#{session_attached}\t#{window_activity}\t#{pane_current_command}\t#{pane_current_path}' 2>/dev/null";

// What may reach a remote shell as a tmux target. A session name can legally
// be almost anything; one that isn't plain is shown but never closable here,
// which is cheaper than quoting it correctly for a shell we can't see.
export const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash"]);
const basename = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

/** `tmux list-panes` output -> Map name -> { attached, activity (s), commands, path }. */
export function parsePanes(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const [name, attached, activity, command, ...path] = line.split("\t");
    if (!name || command === undefined) continue;
    const cur = out.get(name) ?? { attached: 0, activity: 0, commands: [], path: path.join("\t") };
    cur.attached = Math.max(cur.attached, Number(attached) || 0);
    cur.activity = Math.max(cur.activity, Number(activity) || 0);
    cur.commands.push(command);
    out.set(name, cur);
  }
  return out;
}

const KIND_ORDER = { copy: 0, other: 1, use: 2 };

/**
 * One row per tmux session: `kind` is "copy" (an older process of a session id
 * a newer pane also runs), "other" (nothing Claude in it), or "use". Only the
 * first two can be `closable`, and only while nobody is attached and nothing is
 * working — the newest copy of a session id is never a copy, so closing every
 * "copy" can't lose the last live process of anything.
 *
 * `sessions` are this host's live registry entries (nested ones ignored). The
 * newest copy is by `started`, then pid.
 */
export function classifyTmux(panes, sessions, now = Date.now()) {
  const live = sessions.filter((s) => !s.nested && s.tmux);
  const newest = new Map();
  for (const s of live) {
    const cur = newest.get(s.session_id);
    if (!cur || (s.started ?? 0) > (cur.started ?? 0) || ((s.started ?? 0) === (cur.started ?? 0) && s.pid > cur.pid)) newest.set(s.session_id, s);
  }
  const rows = [];
  for (const [name, p] of panes) {
    const mine = live.filter((s) => s.tmux === name);
    const row = { name, attached: p.attached, idle: Math.max(0, Math.floor(now / 1000) - p.activity), kind: "use", closable: false, project: "", title: "", why: "" };
    const first = mine[0];
    row.project = first ? basename(first.folder ?? first.cwd) : basename(p.path) || "home";
    row.title = first ? (first.aiTitle ?? first.name ?? "") : (p.commands[0] ?? "");
    const busy = mine.some((s) => s.state === "busy");
    const newer = [...new Set(mine.map((s) => newest.get(s.session_id)).filter((n) => n && !mine.includes(n)).map((n) => n.tmux))];
    const shadowed = mine.length > 0 && mine.every((s) => newest.get(s.session_id) !== s);
    if (!SAFE_NAME.test(name)) row.why = "unusual name, close it by hand";
    else if (p.attached > 0) row.why = shadowed ? `attached, also open in tmux ${newer.join(", ")}` : "attached";
    else if (busy) row.why = "working";
    else if (shadowed) {
      row.kind = "copy";
      row.closable = true;
      row.why = `same session open in tmux ${newer.join(", ")}`;
    } else if (mine.length) row.why = "detached, the only copy of its session";
    else if (p.commands.includes("claude")) row.why = "Claude with no session yet";
    else {
      row.kind = "other";
      row.closable = true;
      const cmd = p.commands[0] ?? "";
      row.why = SHELLS.has(cmd) ? "idle shell, nothing running" : `running ${cmd}`;
    }
    rows.push(row);
  }
  return rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Close the named sessions. The listing is taken again *now* rather than
 * trusting what the page was drawn from: a session attached or started working
 * since is skipped, and a name the host no longer has is just gone. The browser
 * only said which boxes were ticked; whether each may be closed is decided here.
 *
 * Returns `[{ name, ok, why? }]`, one per name asked for, in order.
 */
export async function closeTmux(names, { list, sessions, kill }) {
  const panes = await list();
  if (!panes) return names.map((name) => ({ name, ok: false, why: "host not answering" }));
  const rows = classifyTmux(panes, sessions());
  const out = [];
  for (const name of names) {
    const row = rows.find((r) => r.name === name);
    if (!row) out.push({ name, ok: false, why: "already gone" });
    else if (!row.closable) out.push({ name, ok: false, why: `in use now: ${row.why}` });
    else {
      const ok = await kill(name);
      out.push(ok ? { name, ok } : { name, ok, why: "tmux refused" });
    }
  }
  return out;
}
