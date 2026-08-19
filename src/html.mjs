// The two escapes every page here needs, in one place because two files now
// render markup (config-server.mjs and board-page.mjs) and the alternative was
// an import cycle between them.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// The full five-entity escape, not tags only. Folder keys reach these pages
// from the filesystem and, for a remote project, from another machine's
// registry — and several of them land in *attribute* context, where a double
// quote breaks out with no `<` involved. A tag-only escaper passes a
// `<script>` test case while still being injectable.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

// An accent reaches a CSS colour slot, which is the same trust boundary but
// not the same treatment: `esc` makes a string safe as *text*, and a colour is
// not text. readAccents only checks that the stored value is a string, so a
// hand-edited accents file could otherwise put `url(...)` into a background.
// Anything that is not a plain hex becomes the neutral.
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
export const colour = (c) => (HEX.test(String(c)) ? String(c) : "#555555");
