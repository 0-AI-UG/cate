#!/bin/zsh
# =============================================================================
# Install (or remove) the weekly launchd schedule for the live agent-CLI
# contract suite. The job runs agent-contracts-weekly.sh every Monday at 11:00
# local time via a login shell (so node/npm and the agent CLIs are on PATH).
#
#   ./scripts/install-agent-contracts-schedule.sh [repo-path]   # install
#   ./scripts/install-agent-contracts-schedule.sh --uninstall   # remove
#
# repo-path defaults to this script's repo checkout. Pass the CANONICAL clone
# (e.g. ~/Dev/cate) when installing from a temporary worktree — the plist
# guards on the runner script existing, so scheduling a path where the branch
# has not landed yet is a silent no-op until it does.
# =============================================================================
set -eu

LABEL="com.cate.agent-contracts"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL ($PLIST)"
  exit 0
fi

REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
RUNNER="$REPO/scripts/agent-contracts-weekly.sh"

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>[ -x '$RUNNER' ] &amp;&amp; '$RUNNER' || true</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>11</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

launchctl unload -w "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "Installed $LABEL: Mondays 11:00, runner $RUNNER"
echo "Log: ~/Library/Logs/cate-agent-contracts.log · Remove with: $0 --uninstall"
