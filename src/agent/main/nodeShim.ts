import fs from 'fs'
import path from 'path'

/**
 * Create a shim so that `node` on PATH resolves to the Electron binary
 * (which behaves as Node when ELECTRON_RUN_AS_NODE=1 is set in the env).
 *
 * On macOS/Linux this is a symlink. On Windows it must be a real `node.exe`:
 * pi's RpcClient launches the agent via a shell-less `spawn("node", ...)`,
 * and CreateProcess only resolves `node`/`node.exe` on PATH — never `.cmd`.
 * A `node.cmd` wrapper is therefore invisible to that spawn and yields
 * `spawn node ENOENT`. We hardlink `node.exe` to the Electron binary (cheap,
 * no Developer Mode/admin needed on the same volume) and fall back to a copy
 * when a hardlink isn't possible (e.g. shim dir on a different volume).
 */
export function createNodeShim(
  dir: string,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  fs.mkdirSync(dir, { recursive: true })

  if (platform === 'win32') {
    const exePath = path.join(dir, 'node.exe')
    try { fs.unlinkSync(exePath) } catch { /* didn't exist */ }
    try {
      fs.linkSync(execPath, exePath)
    } catch {
      fs.copyFileSync(execPath, exePath)
    }
  } else {
    const linkPath = path.join(dir, 'node')
    try { fs.unlinkSync(linkPath) } catch { /* didn't exist */ }
    fs.symlinkSync(execPath, linkPath)
  }
}
