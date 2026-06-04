#!/bin/bash
# Patch Electron.app Info.plist so macOS dock shows "Cate" instead of "Electron"
# Restore exec bit on node-pty's spawn-helper — npm sometimes strips it on
# extraction, causing posix_spawnp to fail at runtime.
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# Ensure Electron's binary is present before we try to launch it. pnpm (used for
# git worktrees) blocks dependency build scripts by default, so a fresh worktree
# install leaves the `electron` package without its downloaded binary — no dist/
# or path.txt — and `electron-vite dev` then fails with "Error: Electron
# uninstall". Materialize it directly via Electron's own installer (the download
# is cached globally, so this is ~1s after the first machine-wide install). This
# is a no-op on npm installs, where the binary is already in place.
if [ ! -e "node_modules/electron/dist" ] && [ -f "node_modules/electron/install.js" ]; then
  echo "[patch-electron-name] Electron binary missing — installing…"
  node node_modules/electron/install.js
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
