// Runs patch-electron-name.sh (macOS dock name, Electron install check) from
// `predev`. Skipped on Windows: `bash` there is usually WSL's, and the script's
// `node install.js` would then put the Linux Electron into the Windows
// node_modules (path.txt `electron`, Linux files in dist), which crashes at startup.
import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32') {
  process.exit(spawnSync('bash', ['scripts/patch-electron-name.sh'], { stdio: 'inherit' }).status ?? 1)
}
