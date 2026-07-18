#!/bin/zsh
# =============================================================================
# Weekly live run of the agent-CLI hook contracts (agentHookContracts
# .itest.ts) — the early-warning system for terminal session-restore: the hook
# surfaces and store shapes Cate reads can move under a CLI update, and this
# run catches the drift pre-release.
#
# Drives the REAL locally-installed CLIs with the user's accounts (a few tiny
# prompts — cents per run). Logs to ~/Library/Logs/cate-agent-contracts.log
# and raises a macOS notification on failure.
#
# Scheduled via launchd — see scripts/install-agent-contracts-schedule.sh.
# =============================================================================
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/cate-agent-contracts.log"
mkdir -p "$(dirname "$LOG")"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') live agent-CLI contract run ($REPO) ==="
  cd "$REPO" || exit 0
  if npm run --silent test:agent-contracts; then
    echo "=== PASS $(date '+%Y-%m-%d %H:%M:%S') ==="
  else
    echo "=== FAIL $(date '+%Y-%m-%d %H:%M:%S') ==="
    osascript -e 'display notification "An agent CLI changed its session-store contract — terminal session restore may be broken. See ~/Library/Logs/cate-agent-contracts.log" with title "Cate: agent contract tests FAILED"' 2>/dev/null || true
    exit 1
  fi
} >> "$LOG" 2>&1
