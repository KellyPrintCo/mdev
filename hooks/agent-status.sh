#!/usr/bin/env bash
# Claude Code hook: forwards hook events to the Agent Status dashboard.
# Never blocks or fails the agent: posts in the background and always exits 0.
#
# Config (env vars, or ~/.claude/agent-status.env):
#   AGENT_STATUS_URL    e.g. https://agents.example.com
#   AGENT_STATUS_TOKEN  the INGEST_TOKEN secret set on the Pages project

[ -f "$HOME/.claude/agent-status.env" ] && . "$HOME/.claude/agent-status.env"
payload=$(cat)
[ -z "${AGENT_STATUS_URL:-}" ] || [ -z "${AGENT_STATUS_TOKEN:-}" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

field() { # crude top-level string field extraction; jq is used when available
  if command -v jq >/dev/null 2>&1; then printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null
  else printf '%s' "$payload" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1; fi
}

cwd=$(field cwd); cwd=${cwd:-$PWD}
event=$(field hook_event_name)
branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
project=$(basename "${top:-$cwd}")
host=$(hostname 2>/dev/null || uname -n)

usage=""
if [ "$event" = "Stop" ] || [ "$event" = "SessionEnd" ]; then
  transcript=$(field transcript_path)
  if [ -n "$transcript" ] && [ -f "$transcript" ] && command -v jq >/dev/null 2>&1; then
    usage=$(jq -cs '[.[] | select(.type=="assistant" and .message.usage) | {id: .message.id, u: .message.usage}]
      | unique_by(.id) | map(.u)
      | {input: (map(.input_tokens // 0) | add // 0), output: (map(.output_tokens // 0) | add // 0),
         cache_read: (map(.cache_read_input_tokens // 0) | add // 0),
         cache_write: (map(.cache_creation_input_tokens // 0) | add // 0)}' "$transcript" 2>/dev/null || true)
  fi
fi

(
  printf '%s' "$payload" | curl -sS -m 5 -o /dev/null -X POST "${AGENT_STATUS_URL%/}/api/ingest" \
    -H "Authorization: Bearer $AGENT_STATUS_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Host: $host" \
    -H "X-Agent-Project: $project" \
    -H "X-Agent-Branch: $branch" \
    ${CLAUDE_CODE_REMOTE_SESSION_ID:+-H "X-Agent-Remote: $CLAUDE_CODE_REMOTE_SESSION_ID"} \
    ${usage:+-H "X-Agent-Usage: $usage"} \
    --data-binary @- 
) >/dev/null 2>&1 &

exit 0
