#!/bin/bash
# Patch Electron.app Info.plist so macOS dock shows "Cate" instead of "Electron"
# Restore exec bit on node-pty's spawn-helper — npm sometimes strips it on
# extraction, causing posix_spawnp to fail at runtime.
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
# Same for the bundled ripgrep binary used by the Search view.
chmod +x node_modules/@vscode/ripgrep*/bin/rg 2>/dev/null || true

# Ensure Electron's binary is present before we try to launch it. pnpm (used for
# git worktrees) blocks dependency build scripts by default, so a fresh worktree
# install leaves the `electron` package without its downloaded binary — no dist/
# or path.txt — and `electron-vite dev` then fails with "Error: Electron
# uninstall". Let Electron's installer check its version, path.txt and executable:
# dist/ alone can also be left behind by an incomplete install. The installer is
# a no-op when already installed and reuses the global download cache otherwise.
if [ -f "node_modules/electron/install.js" ]; then
  node node_modules/electron/install.js || exit $?
  # An installer process can exit successfully before extraction finishes on an
  # unsupported Node version. Do not let dev proceed with that partial install.
  node -e 'const fs = require("node:fs"); const path = require("node:path"); const root = path.dirname(require.resolve("electron")); if (!fs.existsSync(require("electron")) || fs.readFileSync(path.join(root, "dist/version"), "utf8").trim().replace(/^v/, "") !== require("electron/package.json").version) process.exit(1)' || {
    echo "[patch-electron-name] Electron installation is incomplete. Use Node.js 22 (see package.json engines) and retry npm rebuild electron." >&2
    exit 1
  }
fi

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set CFBundleDisplayName Cate" "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set CFBundleName Cate" "$PLIST" 2>/dev/null
  # Also replace the .icns (may not exist yet before first icon generation)
  if [ -f "build/icon.icns" ]; then
    cp build/icon.icns "node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
  fi
fi
