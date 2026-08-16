# Claude Stream Deck terminal focus

Reveals the terminal of the Claude Code session whose Stream Deck key was
pressed — the joined split group comes forward with the right pane active, or
the right terminal tab is selected.

Install with `npm run ext:install` from the repository root, then run
`Developer: Reload Window` in each VS Code window that is already open. New
windows pick it up on their own.

No commands, no settings, nothing to configure. It polls
`~/.claude/streamdeck-focus.json` every 400ms and acts only when that file
names a terminal this window owns.

Design: `../docs/superpowers/specs/2026-08-15-terminal-focus-extension-design.md`
