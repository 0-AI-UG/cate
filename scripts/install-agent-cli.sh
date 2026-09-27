#!/usr/bin/env bash
# Latest public CLI releases: deliberately not cached/pinned, to detect upstream drift.
set -euo pipefail

case "${1:?Pass a supported agent id}" in
  claude-code) npm install --global @anthropic-ai/claude-code@latest ;;
  codex) npm install --global @openai/codex@latest ;;
  cursor) curl --fail --silent --show-error --location https://cursor.com/install | bash ;;
  grok) npm install --global @xai-official/grok@latest ;;
  opencode) npm install --global opencode-ai@latest ;;
  kiro) curl --fail --silent --show-error --location https://cli.kiro.dev/install | bash ;;
  hermes)
    curl --fail --silent --show-error --location https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh |
      bash -s -- --non-interactive --skip-browser
    ;;
  *) echo "Unknown agent id: $1" >&2; exit 2 ;;
esac

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$HOME/.local/bin" "$HOME/.hermes/bin" >> "$GITHUB_PATH"
fi
