#!/bin/bash
# Patch Electron.app Info.plist so macOS dock shows "Cate" instead of "Electron"
# Restore exec bit on node-pty's spawn-helper — npm sometimes strips it on
# extraction, causing posix_spawnp to fail at runtime.
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set CFBundleDisplayName Cate" "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set CFBundleName Cate" "$PLIST" 2>/dev/null
  # Also replace the .icns (may not exist yet before first icon generation)
  if [ -f "build/icon.icns" ]; then
    cp build/icon.icns "node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
  fi
fi
