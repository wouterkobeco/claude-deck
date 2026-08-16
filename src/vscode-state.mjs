import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STORAGE_DIR = join(homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
const EDITOR_KEY = "memento/workbench.parts.editor";

// folder -> workspaceStorage dir. Stable for a window's lifetime, so cache it;
// the editor state inside is re-read every time since it changes constantly.
const storageDirCache = new Map();

function isUnder(file, folder) {
  return file === folder || file.startsWith(folder.endsWith("/") ? folder : folder + "/");
}

/**
 * Finds the workspaceStorage directory VS Code uses for a given folder.
 * Several can exist for one folder (older ones linger from previous
 * installs), so the most recently written wins.
 */
/**
 * How VS Code records a window's folder in `workspace.json`.
 *
 * A local window writes `file:///Users/...`. A Remote-SSH window writes
 * `vscode-remote://ssh-remote%2B<host><path>` — note the `+` arrives
 * percent-encoded, which is why this is built rather than compared loosely.
 */
function workspaceUri(folder, host) {
  return host ? `vscode-remote://ssh-remote%2B${host}${folder}` : `file://${folder}`;
}

async function storageDirFor(folder, host, storageDir = STORAGE_DIR) {
  const cacheKey = `${host ?? ""}:${folder}`;
  if (storageDirCache.has(cacheKey)) return storageDirCache.get(cacheKey);

  let best = null;
  let bestMtime = -Infinity;
  let names = [];
  try {
    names = await readdir(storageDir);
  } catch {
    storageDirCache.set(cacheKey, null);
    return null;
  }

  const wanted = workspaceUri(folder, host);
  for (const name of names) {
    const dir = join(storageDir, name);
    try {
      const meta = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
      if (meta.folder !== wanted) continue;
      const { mtimeMs } = await stat(join(dir, "state.vscdb"));
      if (mtimeMs > bestMtime) {
        best = dir;
        bestMtime = mtimeMs;
      }
    } catch {
      // no workspace.json / no state.vscdb / unreadable — not a candidate
    }
  }

  storageDirCache.set(cacheKey, best);
  return best;
}

/**
 * Returns a file already open in the VS Code window for `folder`, preferring
 * the most recently used one (which is normally the active editor).
 *
 * Opening such a file focuses that window without adding a tab — and when
 * it's the active editor, without any visible change at all. Entries outside
 * the folder are skipped: opening one of those would focus whichever *other*
 * window owns it.
 *
 * Returns null if the state can't be read or holds nothing usable; callers
 * fall back to a static anchor file. This reads VS Code's internal state
 * format, so it's all best-effort by design.
 */
export async function openFileIn(folder, host = null, storageDir = STORAGE_DIR) {
  try {
    const dir = await storageDirFor(folder, host, storageDir);
    if (!dir) return null;

    const { stdout } = await execFileAsync(
      "sqlite3",
      [join(dir, "state.vscdb"), `select value from ItemTable where key='${EDITOR_KEY}'`],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    if (!stdout.trim()) return null;

    const grid = JSON.parse(stdout)["editorpart.state"]?.serializedGrid?.root;
    if (!grid) return null;

    const groups = [];
    const collect = (node) => {
      if (node?.type === "leaf") groups.push(node.data);
      if (Array.isArray(node?.data)) node.data.forEach(collect);
    };
    collect(grid);

    for (const group of groups) {
      const editors = group?.editors ?? [];
      const mru = group?.mru ?? editors.map((_, i) => i);
      for (const idx of mru) {
        let value;
        try {
          value = JSON.parse(editors[idx]?.value ?? "{}");
        } catch {
          continue;
        }
        const resource = value?.resourceJSON;
        const path = resource?.path;
        if (!path || !isUnder(path, folder)) continue;
        if (!host) return path;
        // A remote window's editors are `vscode-remote://` URIs, and `open`
        // cannot take one — the raise goes through `code --file-uri` instead.
        // VS Code has already written the encoded form in `external`, so it is
        // returned verbatim rather than rebuilt: the authority arrives as
        // `ssh-remote%2B<host>` and re-encoding it by hand is a bug waiting to
        // happen.
        //
        // The authority is checked, not assumed. One window's storage can
        // outlive the folder being reopened against a different host, and
        // opening the wrong host's file focuses the wrong window — the exact
        // confusion `folderKeyFor` exists to prevent one layer up.
        if (resource.scheme === "vscode-remote" && resource.authority === `ssh-remote+${host}` && resource.external) {
          return resource.external;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
