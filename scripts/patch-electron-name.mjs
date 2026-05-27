import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const root = process.cwd()

function chmodSpawnHelpers() {
  const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds')
  if (process.platform === 'win32' || !fs.existsSync(prebuilds)) return

  for (const platformDir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platformDir, 'spawn-helper')
    if (!fs.existsSync(helper)) continue
    try {
      fs.chmodSync(helper, 0o755)
    } catch {
      // Best-effort only. Dev/build should not fail if chmod is unnecessary.
    }
  }
}

function patchMacElectronApp() {
  if (process.platform !== 'darwin') return

  const plist = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist')
  if (!fs.existsSync(plist)) return

  const plistBuddy = '/usr/libexec/PlistBuddy'
  for (const [key, value] of [['CFBundleDisplayName', 'Cate'], ['CFBundleName', 'Cate']]) {
    try {
      execFileSync(plistBuddy, ['-c', `Set ${key} ${value}`, plist], { stdio: 'ignore' })
    } catch {
      // Electron package layout can differ in dev; patch is cosmetic.
    }
  }

  const icon = path.join(root, 'build', 'icon.icns')
  const targetIcon = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Resources', 'electron.icns')
  if (fs.existsSync(icon)) {
    try {
      fs.copyFileSync(icon, targetIcon)
    } catch {
      // Cosmetic patch only.
    }
  }
}

chmodSpawnHelpers()
patchMacElectronApp()
