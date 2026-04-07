// =============================================================================
// Auto-updater — checks for new releases on GitHub and installs updates.
// Uses electron-updater natively; falls back to GitHub Releases API + manual
// download when native updating fails (e.g. unsigned builds).
// =============================================================================

import { app, dialog, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import log from './logger'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_OWNER = '0-AI-UG'
const GITHUB_REPO = 'cate'
const API_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let isManualCheck = false
let fallbackInProgress = false

/** Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Return the expected release-asset filename for this platform + arch. */
function getAssetName(version: string): string | null {
  const v = version.replace(/^v/, '')
  switch (process.platform) {
    case 'darwin':
      return process.arch === 'arm64' ? `Cate-${v}-arm64.dmg` : `Cate-${v}.dmg`
    case 'win32':
      return `Cate-Setup-${v}.exe`
    case 'linux':
      return `Cate-${v}.AppImage`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Native-updater dialog (shown when electron-updater finds an update)
// ---------------------------------------------------------------------------

function showUpdateDialog(info: { version: string }): void {
  const win = BrowserWindow.getFocusedWindow()
  dialog
    .showMessageBox({
      ...(win ? { parentWindow: win } : {}),
      type: 'info',
      title: 'Update Available',
      message: `A new version of Cate (v${info.version}) is available.`,
      detail: 'Would you like to download and install it?',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate()
      }
    })
}

// ---------------------------------------------------------------------------
// Progress window for fallback downloads
// ---------------------------------------------------------------------------

function createProgressWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 120,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#1f1e1c',
    webPreferences: { contextIsolation: true },
  })

  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1f1e1c; color: #e0e0e0; padding: 24px; display: flex;
         flex-direction: column; justify-content: center; height: 100vh;
         -webkit-app-region: drag; }
  .label { font-size: 13px; margin-bottom: 12px; }
  .track { width: 100%; height: 6px; background: #333; border-radius: 3px; overflow: hidden; }
  .bar   { height: 100%; width: 0%; background: #6C8EEF; border-radius: 3px;
            transition: width .2s ease; }
</style></head><body>
  <div class="label" id="label">Downloading update…</div>
  <div class="track"><div class="bar" id="bar"></div></div>
</body></html>`

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  win.once('ready-to-show', () => win.show())
  return win
}

function setProgress(win: BrowserWindow, pct: number): void {
  if (win.isDestroyed()) return
  const js = `document.getElementById('bar').style.width='${Math.round(pct)}%';`
    + `document.getElementById('label').textContent='Downloading update… ${Math.round(pct)}%';`
  win.webContents.executeJavaScript(js).catch(() => {})
}

function setStatus(win: BrowserWindow, text: string, indeterminate = false): void {
  if (win.isDestroyed()) return
  const bar = indeterminate ? '100' : null
  const js =
    (bar ? `document.getElementById('bar').style.width='${bar}%';` : '') +
    `document.getElementById('label').textContent=${JSON.stringify(text)};`
  win.webContents.executeJavaScript(js).catch(() => {})
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': `Cate/${app.getVersion()}`, Accept: 'application/octet-stream' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('Download failed: no response body')

  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const fileStream = fs.createWriteStream(dest)

  const reader = res.body.getReader()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    fileStream.write(Buffer.from(value))
    received += value.byteLength
    if (total > 0 && onProgress) onProgress((received / total) * 100)
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
    fileStream.end()
  })
}

// ---------------------------------------------------------------------------
// Platform-specific install
// ---------------------------------------------------------------------------

function exec(cmd: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}

async function installMacOS(dmgPath: string): Promise<void> {
  // Mount DMG
  const out = await exec('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath])
  // Parse mount point from hdiutil output (last column of last line)
  const mountLine = out.split('\n').pop() || ''
  const mountPoint = mountLine.replace(/^.*\t/, '').trim()
  if (!mountPoint) throw new Error('Could not determine DMG mount point')

  try {
    // Find the .app inside the mounted DMG
    const entries = fs.readdirSync(mountPoint)
    const appName = entries.find((e) => e.endsWith('.app'))
    if (!appName) throw new Error('No .app found in DMG')

    const src = path.join(mountPoint, appName)
    const dest = path.join('/Applications', appName)

    // Remove old version, copy new
    if (fs.existsSync(dest)) {
      await exec('rm', ['-rf', dest])
    }
    await exec('cp', ['-R', src, dest])
    log.info('[fallback-updater] Installed %s to /Applications', appName)
  } finally {
    await exec('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {})
  }

  // Relaunch from new location
  app.relaunch({ execPath: '/Applications/Cate.app/Contents/MacOS/Cate' })
  app.quit()
}

async function installWindows(exePath: string): Promise<void> {
  // Launch NSIS installer — it handles uninstalling the old version
  spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

async function installLinux(appImagePath: string): Promise<void> {
  const currentPath = process.execPath
  fs.copyFileSync(appImagePath, currentPath)
  fs.chmodSync(currentPath, 0o755)
  log.info('[fallback-updater] Replaced AppImage at %s', currentPath)
  app.relaunch()
  app.quit()
}

// ---------------------------------------------------------------------------
// Fallback update check via GitHub Releases API
// ---------------------------------------------------------------------------

interface GitHubRelease {
  tag_name: string
  html_url: string
  assets: { name: string; browser_download_url: string }[]
}

async function fallbackCheckForUpdate(manual: boolean): Promise<void> {
  if (fallbackInProgress) return
  fallbackInProgress = true

  try {
    log.info('[fallback-updater] Checking GitHub releases API…')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(API_LATEST_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': `Cate/${app.getVersion()}`, Accept: 'application/vnd.github.v3+json' },
    })
    clearTimeout(timeout)

    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`)
    const data = (await res.json()) as GitHubRelease

    const latestVersion = data.tag_name
    const currentVersion = app.getVersion()
    log.info('[fallback-updater] Latest: %s  Current: v%s', latestVersion, currentVersion)

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      if (manual) {
        const win = BrowserWindow.getFocusedWindow()
        dialog.showMessageBox({
          ...(win ? { parentWindow: win } : {}),
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version of Cate.',
        })
      }
      return
    }

    // A newer version exists — find the right asset
    const assetName = getAssetName(latestVersion)
    const asset = assetName ? data.assets.find((a) => a.name === assetName) : null

    if (!asset) {
      log.warn('[fallback-updater] No matching asset found for %s on %s/%s', latestVersion, process.platform, process.arch)
      // Fall back to opening the releases page
      const win = BrowserWindow.getFocusedWindow()
      const { response } = await dialog.showMessageBox({
        ...(win ? { parentWindow: win } : {}),
        type: 'info',
        title: 'Update Available',
        message: `Cate ${latestVersion} is available (you have v${currentVersion}).`,
        detail: 'Could not find an automatic download for your platform. Open the releases page?',
        buttons: ['Open Releases Page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) shell.openExternal(data.html_url)
      return
    }

    // Ask user to confirm download
    const parentWin = BrowserWindow.getFocusedWindow()
    const { response } = await dialog.showMessageBox({
      ...(parentWin ? { parentWindow: parentWin } : {}),
      type: 'info',
      title: 'Update Available',
      message: `Cate ${latestVersion} is available (you have v${currentVersion}).`,
      detail: 'Download and install the update? The app will restart when complete.',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return

    // Download with progress
    const tmpDir = app.getPath('temp')
    const destPath = path.join(tmpDir, asset.name)

    const progressWin = createProgressWindow()
    try {
      await downloadFile(asset.browser_download_url, destPath, (pct) => {
        setProgress(progressWin, pct)
      })

      log.info('[fallback-updater] Downloaded %s', destPath)
      setStatus(progressWin, 'Installing update…', true)

      // Install per platform
      switch (process.platform) {
        case 'darwin':
          await installMacOS(destPath)
          break
        case 'win32':
          await installWindows(destPath)
          break
        case 'linux':
          await installLinux(destPath)
          break
        default:
          shell.openExternal(data.html_url)
      }
    } finally {
      if (!progressWin.isDestroyed()) progressWin.destroy()
    }
  } catch (err: any) {
    log.error('[fallback-updater] Error:', err)
    if (manual) {
      const win = BrowserWindow.getFocusedWindow()
      dialog.showMessageBox({
        ...(win ? { parentWindow: win } : {}),
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: err.message || 'Please check your internet connection.',
      })
    }
  } finally {
    fallbackInProgress = false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initAutoUpdater(): void {
  // Don't check for updates in dev mode
  if (!app.isPackaged) return

  log.info('Auto-updater initialized')

  autoUpdater.on('update-available', (info) => {
    log.info('Update available: v%s', info.version)
    showUpdateDialog(info)
  })

  autoUpdater.on('update-not-available', () => {
    log.info('No updates available')
    if (isManualCheck) {
      isManualCheck = false
      const win = BrowserWindow.getFocusedWindow()
      dialog.showMessageBox({
        ...(win ? { parentWindow: win } : {}),
        type: 'info',
        title: 'No Updates',
        message: 'You are running the latest version of Cate.',
      })
    }
  })

  autoUpdater.on('update-downloaded', () => {
    log.info('Update downloaded, ready to install')
    const win = BrowserWindow.getFocusedWindow()
    dialog
      .showMessageBox({
        ...(win ? { parentWindow: win } : {}),
        type: 'info',
        title: 'Update Ready',
        message: 'The update has been downloaded.',
        detail: 'Restart Cate now to apply the update?',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...')
  })

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err)
    // Native auto-update failed (e.g. no code signing) — try fallback
    const wasManual = isManualCheck
    isManualCheck = false
    fallbackCheckForUpdate(wasManual)
  })

  // Check on launch (after a short delay to not block startup)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[auto-updater] Startup check threw, trying fallback:', err)
      fallbackCheckForUpdate(false)
    })
  }, 5000)

  // Check every 4 hours
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn('[auto-updater] Periodic check threw, trying fallback:', err)
        fallbackCheckForUpdate(false)
      })
    },
    4 * 60 * 60 * 1000,
  )
}

export function checkForUpdatesManually(): void {
  isManualCheck = true
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('[auto-updater] Manual check threw, trying fallback:', err)
    isManualCheck = false
    fallbackCheckForUpdate(true)
  })
}
