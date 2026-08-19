// The board's address, remembered between runs.
//
// The server used to take an ephemeral port and mint a fresh token every
// start, which is right for something you open from a key press and wrong for
// something you *scan onto an iPad*: the URL changed on every restart, so a
// bookmark broke and a page left open on the wall stayed grey until you
// scanned a new code. Both halves of that URL therefore have to outlive the
// process, not just the port — a stable port with a rotating token is still a
// dead bookmark.
//
// The daemon's seventh file, and the second that is its own memory rather than
// a message to another process (`streamdeck-accents.json` was the first). It
// earns one by the bar CLAUDE.md sets — a reader that cannot get at the
// existing file: the accents record is a folder→colour map with its own
// retention and its own shape, and this is two scalars about a socket.
//
// Written 0600. It holds a bearer token for a service on your LAN, which is a
// different thing from a colour map, and the rest of ~/.claude is not a reason
// to be careless with the one file here that is a credential.
//
// Best-effort like every other reader here: a missing, unreadable or corrupt
// file is a first run, and a failed write is a restart that forgets — you
// scan the new code once and it is remembered again.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");
const fileIn = (root) => join(root, "streamdeck-board.json");

// Not 8080. That is the most standard alternative HTTP port and therefore the
// most likely to already be answering on a machine that runs dev servers —
// measured here, 8080 was in use, along with 3000, 5000 and 8888, so it would
// have warned on every start. 8765 is in the same register, is not assigned to
// anything in common use, and sits well below the ephemeral range macOS hands
// out (49152+), so nothing else will drift onto it.
export const DEFAULT_PORT = 8765;

/**
 * The remembered port and token, or nulls for a first run.
 *
 * Every field is validated rather than trusted: this file is small enough to
 * hand-edit and the port reaches `listen()` while the token is compared
 * against a query parameter. A port outside the usable range, or a token that
 * isn't a plausible one, reads as "nothing remembered" — which costs a new QR
 * scan and never a confusing failure.
 */
export function readBoardState(root = CLAUDE_DIR) {
  try {
    const raw = JSON.parse(readFileSync(fileIn(root), "utf8"));
    const port = Number.isInteger(raw?.port) && raw.port > 0 && raw.port < 65536 ? raw.port : null;
    // A UUID, because that is what randomUUID makes and the only thing this
    // ever writes. Anything else is a hand-edited file or a corrupt one, and a
    // short or guessable token is precisely the value not to accept back.
    const token = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw?.token) ? raw.token : null;
    return { port, token };
  } catch {
    return { port: null, token: null };
  }
}

/** Best-effort: a restart that forgets is one more QR scan, never an error. */
export function writeBoardState({ port, token }, root = CLAUDE_DIR) {
  try {
    writeFileSync(fileIn(root), JSON.stringify({ port, token }), { mode: 0o600 });
  } catch {
    // A read-only home directory, a full disk. The board still works this run.
  }
}
