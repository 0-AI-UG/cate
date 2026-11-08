import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** Give Metal a fresh cache identity without clearing the user's GPU caches. */
export function copyElectronForColdGpuCache(source: string): { root: string; executablePath: string } {
  if (process.platform !== 'darwin') throw new Error('Metal cache isolation requires macOS')
  const root = mkdtempSync('/private/tmp/cate-cold-gpu-')
  const copy = path.join(root, 'Electron.app')
  execFileSync('/bin/cp', ['-cR', path.resolve(source, '../../..'), copy])
  const frameworks = path.join(copy, 'Contents/Frameworks')
  const bundles = [copy, ...readdirSync(frameworks).filter(name => name.endsWith('.app')).map(name => path.join(frameworks, name))]
  for (const bundle of bundles) {
    const plist = path.join(bundle, 'Contents/Info.plist')
    const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim()
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${id}.${path.basename(root)}`, plist])
  }
  return { root, executablePath: path.join(copy, 'Contents/MacOS/Electron') }
}
