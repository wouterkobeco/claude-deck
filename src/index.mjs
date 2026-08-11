import { execFile } from "node:child_process";
import { listStreamDecks, openStreamDeck } from "@elgato-stream-deck/node";
import { getLiveSessions } from "./sessions.mjs";
import { renderKey, renderBlank } from "./render.mjs";

const POLL_MS = 2000;
const RECONNECT_MS = 5000;

function focusWindow(folder) {
  execFile("code", ["-r", folder], (err) => {
    if (err) console.error(`focus failed for ${folder}:`, err.message);
  });
}

async function refresh(deck, buttons) {
  const sessions = await getLiveSessions();
  const bySlot = sessions.slice(0, buttons.length);

  await Promise.all(
    buttons.map(async (btn, slot) => {
      const session = bySlot[slot];
      const prev = btn.assigned;
      btn.assigned = session ?? null;

      if (!session) {
        if (prev) await deck.fillKeyBuffer(btn.index, await renderBlank(btn), { format: "rgba" });
        return;
      }
      // Label from the session's own cwd, not the matched workspace folder:
      // multiple worktree sessions can share one open VS Code window (same
      // folder), so the folder's basename alone wouldn't tell them apart.
      const label = session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
      const buf = await renderKey({ ...btn, state: session.state, label });
      await deck.fillKeyBuffer(btn.index, buf, { format: "rgba" });
    })
  );
}

async function run() {
  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new Error("No Stream Deck found. Is it plugged in?");
  }
  const deck = await openStreamDeck(devices[0].path);
  console.log(`Connected to ${deck.PRODUCT_NAME}`);

  const buttons = deck.CONTROLS.filter((c) => c.type === "button").map((c) => ({
    index: c.index,
    width: c.pixelSize.width,
    height: c.pixelSize.height,
    assigned: null,
  }));

  let disconnected = false;
  deck.on("error", (err) => {
    console.error("Stream Deck error:", err);
    disconnected = true;
  });
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const btn = buttons[control.index];
    if (btn?.assigned) focusWindow(btn.assigned.folder);
  });

  while (!disconnected) {
    try {
      await refresh(deck, buttons);
    } catch (err) {
      console.error("refresh failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await deck.close().catch(() => {});
}

async function main() {
  let connectedOnce = false;
  for (;;) {
    try {
      await run();
      connectedOnce = true;
    } catch (err) {
      console.error(err.message);
      if (!connectedOnce) {
        // Not found at startup: fail fast so the user can plug it in and rerun,
        // rather than silently retrying forever.
        process.exit(1);
      }
    }
    console.log(`Reconnecting in ${RECONNECT_MS / 1000}s...`);
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
  }
}

main();
