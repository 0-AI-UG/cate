import fs from 'fs'
import path from 'path'

/**
 * Create a shim so that `node` on PATH resolves to the Electron binary
 * running with ELECTRON_RUN_AS_NODE=1.
 *
 * On macOS/Linux this is a symlink.  On Windows, symlinks require Developer
 * Mode or admin privileges — so we write a lightweight `node.cmd` batch
 * wrapper instead.
 */
export function createNodeShim(
  dir: string,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  fs.mkdirSync(dir, { recursive: true })

  if (platform === 'win32') {
    const cmdPath = path.join(dir, 'node.cmd')
    const script = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`
    fs.writeFileSync(cmdPath, script)
  } else {
    const linkPath = path.join(dir, 'node')
    try { fs.unlinkSync(linkPath) } catch { /* didn't exist */ }
    fs.symlinkSync(execPath, linkPath)
  }
}
