#!/usr/bin/env bash
# Writes/clears ~/.claude/session-status/<session_id>.json from a Claude Code
# hook's stdin JSON. Invoked by hooks configured in ~/.claude/settings.json.
set -euo pipefail

STATUS_DIR="$HOME/.claude/session-status"
mkdir -p "$STATUS_DIR"

write_status() {
  local state="$1" input="$2"
  local session_id cwd ts
  session_id=$(jq -r '.session_id // empty' <<<"$input")
  cwd=$(jq -r '.cwd // empty' <<<"$input")
  [ -z "$session_id" ] && return 0
  ts=$(date +%s)
  jq -n --arg session_id "$session_id" --arg cwd "$cwd" --arg state "$state" --argjson ts "$ts" \
    '{session_id: $session_id, cwd: $cwd, state: $state, ts: $ts}' \
    > "$STATUS_DIR/$session_id.json"
}

end_status() {
  local input="$1" session_id
  session_id=$(jq -r '.session_id // empty' <<<"$input")
  [ -z "$session_id" ] && return 0
  rm -f "$STATUS_DIR/$session_id.json"
}

self_check() {
  local fake_id="selfcheck-$$"
  local fake_input
  fake_input=$(jq -n --arg session_id "$fake_id" --arg cwd "/tmp" '{session_id: $session_id, cwd: $cwd}')
  local f="$STATUS_DIR/$fake_id.json"

  write_status "working" "$fake_input"
  if [ ! -f "$f" ]; then echo "self-check FAILED: status file not written" >&2; exit 1; fi
  if [ "$(jq -r '.state' "$f")" != "working" ]; then echo "self-check FAILED: state mismatch" >&2; exit 1; fi
  if [ "$(jq -r '.cwd' "$f")" != "/tmp" ]; then echo "self-check FAILED: cwd mismatch" >&2; exit 1; fi

  end_status "$fake_input"
  if [ -f "$f" ]; then echo "self-check FAILED: status file not deleted on end" >&2; exit 1; fi

  echo "self-check OK"
}

case "${1:-}" in
  --self-check) self_check ;;
  end) end_status "$(cat)" ;;
  idle|working|needs_input) write_status "$1" "$(cat)" ;;
  *) echo "usage: streamdeck-status.sh <idle|working|needs_input|end|--self-check>" >&2; exit 1 ;;
esac
