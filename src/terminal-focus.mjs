/**
 * The daemon half of terminal focus: work out which terminal a session is
 * running in, and ask for it.
 *
 * The join is process ancestry. `Terminal.processId` in the VS Code extension
 * API is the shell's pid; the session registry gives Claude's pid; Claude is a
 * descendant of that shell:
 *
 *   99684 claude  <-  92021 zsh  <-  2433 ptyHost  <-  1316 Code
 *
 * So the daemon sends the whole chain and the extension picks the terminal
 * whose processId is in it. Nothing here assumes a depth, a shell, or a
 * wrapper — the alternative, matching `Terminal.name`, tracks the terminal's
 * creation name rather than the OSC title Claude sets, and would break the
 * moment a terminal is renamed.
 */

/**
 * Every pid from `pid` up to (but not including) pid 1.
 *
 * Pure, and exported for the check, because this is the piece where being
 * subtly wrong is invisible: an off-by-one that drops the shell's own pid
 * matches nothing, and looks identical to "the extension isn't installed".
 *
 * Stops on three things: reaching pid 1 (whose inclusion would match every
 * terminal, since it is every process's ancestor), a pid the table doesn't
 * know (the process exited between the registry read and the `ps` call), and
 * a pid already seen. That last one can't happen with a real process table —
 * which is why it's guarded rather than assumed, along with `maxDepth` behind
 * it. A daemon that hangs on a press is worse than one that focuses nothing.
 */
export function ancestorChain(pid, ppidByPid, maxDepth = 20) {
  const chain = [];
  let current = pid;
  while (chain.length < maxDepth && current > 1 && !chain.includes(current)) {
    chain.push(current);
    const parent = ppidByPid.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return chain;
}

/**
 * `ps -Ao pid,ppid` output as pid -> ppid. The columns are right-aligned, so
 * every line has leading whitespace and a plain `split(" ")` would produce
 * empty fields; the first line is a header and the last is empty. Anything
 * that doesn't parse as two integers is skipped rather than stored as NaN.
 */
export function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of stdout.split("\n").slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
  }
  return table;
}
