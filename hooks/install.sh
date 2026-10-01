#!/usr/bin/env bash
# Installs the agent-status hook for every Claude Code session on this machine.
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/hooks/install.sh | bash -s -- <dashboard-url> <token>
# or, from a checkout:   ./hooks/install.sh https://agents.example.com <token>
set -euo pipefail
URL=${1:?usage: install.sh <dashboard-url> <ingest-token>}
TOKEN=${2:?usage: install.sh <dashboard-url> <ingest-token>}
command -v jq >/dev/null || { echo "jq is required (brew install jq / apt install jq)"; exit 1; }

mkdir -p "$HOME/.claude/hooks"
HOOK="$HOME/.claude/hooks/agent-status.sh"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/agent-status.sh"
if [ -f "$SRC" ]; then cp "$SRC" "$HOOK"
else curl -fsSL "${HOOK_SRC_URL:?set HOOK_SRC_URL to the raw agent-status.sh URL}" -o "$HOOK"; fi
chmod +x "$HOOK"

umask 077
printf 'AGENT_STATUS_URL=%q\nAGENT_STATUS_TOKEN=%q\n' "$URL" "$TOKEN" > "$HOME/.claude/agent-status.env"

SETTINGS="$HOME/.claude/settings.json"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
EVENTS='["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Notification","Stop","SubagentStop","PreCompact","SessionEnd"]'
jq --arg cmd "$HOOK" --argjson events "$EVENTS" '
  .hooks //= {} |
  reduce $events[] as $e (.;
    .hooks[$e] = ((.hooks[$e] // []) | map(select(([.hooks[]?.command] | index($cmd)) | not)))
      + [{"matcher": "*", "hooks": [{"type": "command", "command": $cmd, "timeout": 10}]}])
' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

echo "Installed. New Claude Code sessions will report to $URL"
