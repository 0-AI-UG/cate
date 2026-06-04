// =============================================================================
// Auto-updater — checks for new releases on GitHub and installs updates.
// Uses electron-updater natively; when the native updater is unavailable, the
// fallback path only performs version discovery and manual release-page routing.
// It intentionally does not mount, spawn, or replace downloaded assets unless
// a verified installer path is added in the future.
//
// UI: status is pushed to the renderer via UPDATE_STATUS. The renderer renders
// a subtle in-app affordance (no native popups). Renderer dispatches
// UPDATE_DOWNLOAD / UPDATE_INSTALL / UPDATE_OPEN_RELEASE back.
// =============================================================================

import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from './logger'
import { flushAllLoggers } from './ipc/terminal'
import {
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
  UPDATE_STATUS,
  UPDATE_INSTALL,
  UPDATE_DOWNLOAD,
  UPDATE_OPEN_RELEASE,
} from '../shared/ipc-channels'
import { getWindowType } from './windowRegistry'
import { sendEvent } from './analytics'
import { getSettingSync } from './store'
import { compareSemver, isPrereleaseVersion } from './semver'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_OWNER = '0-AI-UG'
const GITHUB_REPO = 'cate'
const API_LATEST_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
// Full release list (newest first), including pre-releases — used by the
// fallback path when the beta channel is opted into, since /releases/latest
// excludes pre-releases by design.
const API_RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

/** True after the user clicked "Update & Restart". The will-quit handler in
 *  src/main/index.ts reads this to skip its `process.reallyExit(0)` fallback —
 *  reallyExit bypasses Electron's relaunch hooks, so the app would install
 *  the update but never come back up. With this flag set, we let Electron's
 *  natural quit path complete so the updater's relaunch fires. */
let updateInstalling = false
export function isInstallingUpdate(): boolean { return updateInstalling }

// ---------------------------------------------------------------------------
// Update status broadcast
// ---------------------------------------------------------------------------

type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; canAutoInstall: boolean; releaseUrl?: string; prerelease?: boolean }
  | { state: 'downloading'; version: string; percent?: number; prerelease?: boolean }
  | { state: 'downloaded'; version: string; prerelease?: boolean }
  | { state: 'manual'; version: string; releaseUrl: string; prerelease?: boolean }
  | { state: 'error'; message: string }

let currentStatus: UpdateStatus = { state: 'idle' }
let latestReleaseUrl: string | null = null

function broadcastStatus(status: UpdateStatus): void {
  currentStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_STATUS, status)
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-update session flush — ask the renderer to persist session state before
// the app restarts for an update. Returns a promise that resolves once the
// renderer ACKs (or after a 3s timeout if the renderer is unresponsive).
// ---------------------------------------------------------------------------

function flushSessionBeforeUpdate(): Promise<void> {
  return new Promise<void>((resolve) => {
    flushAllLoggers()
    const allWindows = BrowserWindow.getAllWindows()
    const mainWin = allWindows.find((w) => !w.isDestroyed() && getWindowType(w.id) === 'main')
    if (!mainWin) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      log.warn('[auto-updater] Session flush timed out, proceeding with update')
      resolve()
    }, 3000)
    ipcMain.once(SESSION_FLUSH_SAVE_DONE, () => {
      clearTimeout(timeout)
      log.info('[auto-updater] Session flush confirmed before update')
      resolve()
    })
    mainWin.webContents.send(SESSION_FLUSH_SAVE)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let isManualCheck = false
let fallbackInProgress = false

// ---------------------------------------------------------------------------
// Fallback update check via GitHub Releases API
// ---------------------------------------------------------------------------

interface GitHubRelease {
  tag_name: string
  html_url: string
  prerelease?: boolean
  draft?: boolean
  assets: { name: string; browser_download_url: string }[]
}

async function fallbackCheckForUpdate(manual: boolean): Promise<void> {
  if (fallbackInProgress) return
  fallbackInProgress = true

  // When the user has opted into beta builds we must consult the full release
  // list — /releases/latest excludes pre-releases — and pick the newest entry,
  // pre-release or not, by semver.
  const includePrereleases = autoUpdater.allowPrerelease === true

  try {
    log.info('[fallback-updater] Checking GitHub releases API… (betas: %s)', includePrereleases)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(includePrereleases ? API_RELEASES_URL : API_LATEST_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': `Cate/${app.getVersion()}`, Accept: 'application/vnd.github.v3+json' },
    })
    clearTimeout(timeout)

    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`)

    let chosen: GitHubRelease | null
    if (includePrereleases) {
      const list = (await res.json()) as GitHubRelease[]
      // Drop drafts, then pick the highest version (pre-releases included).
      chosen = list
        .filter((r) => !r.draft)
        .reduce<GitHubRelease | null>(
          (best, r) => (best === null || compareSemver(r.tag_name, best.tag_name) > 0 ? r : best),
          null,
        )
    } else {
      chosen = (await res.json()) as GitHubRelease
    }

    if (!chosen) {
      broadcastStatus({ state: 'idle' })
      return
    }

    const latestVersion = chosen.tag_name
    const currentVersion = app.getVersion()
    log.info('[fallback-updater] Latest: %s  Current: v%s', latestVersion, currentVersion)

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      if (manual) {
        // Surface "no updates" only for manual checks via a single quiet dialog.
        const win = BrowserWindow.getFocusedWindow()
        dialog.showMessageBox({
          ...(win ? { parentWindow: win } : {}),
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version of Cate.',
        })
      }
      broadcastStatus({ state: 'idle' })
      return
    }

    latestReleaseUrl = chosen.html_url
    // Try native auto-update download first — the initial check may have
    // errored (e.g. provider mismatch) but downloadUpdate can still succeed.
    broadcastStatus({
      state: 'available',
      version: latestVersion.replace(/^v/, ''),
      canAutoInstall: true,
      releaseUrl: chosen.html_url,
      prerelease: chosen.prerelease === true || isPrereleaseVersion(latestVersion),
    })
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
    broadcastStatus({ state: 'error', message: err?.message || 'Update check failed' })
  } finally {
    fallbackInProgress = false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initAutoUpdater(): void {
  // Wire renderer-initiated actions regardless of dev/packaged so the UI never
  // races against handler registration.
  ipcMain.on(UPDATE_DOWNLOAD, () => {
    if (!app.isPackaged) return
    log.info('[auto-updater] Renderer requested download')
    const version = currentStatus.state === 'available' ? currentStatus.version : undefined
    const releaseUrl = currentStatus.state === 'available' ? currentStatus.releaseUrl : latestReleaseUrl
    const prerelease = currentStatus.state === 'available' ? currentStatus.prerelease : undefined
    void sendEvent('update_download_clicked', { version: version ?? null })
    broadcastStatus({ state: 'downloading', version: version ?? '', prerelease })
    autoUpdater.downloadUpdate().catch((err) => {
      log.warn('[auto-updater] downloadUpdate failed, retrying with fresh check:', err)
      // The native updater may not have update info cached (e.g. initial check
      // failed and the update was found via the GitHub API fallback). Re-run the
      // check with autoDownload so the download starts once the update is found.
      autoUpdater.autoDownload = true
      autoUpdater.checkForUpdates()
        .catch((err2: any) => {
          log.error('[auto-updater] Retry check also failed, falling back to manual:', err2)
          autoUpdater.autoDownload = false
          if (releaseUrl && version) {
            broadcastStatus({ state: 'manual', version, releaseUrl, prerelease })
          } else {
            broadcastStatus({ state: 'error', message: err2?.message || 'Download failed' })
          }
        })
        .finally(() => {
          autoUpdater.autoDownload = false
        })
    })
  })

  ipcMain.on(UPDATE_INSTALL, async () => {
    if (!app.isPackaged) return
    log.info('[auto-updater] Renderer requested install')
    const version = currentStatus.state === 'downloaded' ? currentStatus.version : undefined
    void sendEvent('update_install_clicked', { version: version ?? null })
    updateInstalling = true
    await flushSessionBeforeUpdate()
    // (isSilent=false, isForceRunAfter=true) — force relaunch after install
    // on every platform. The default `isForceRunAfter=false` makes Win/Linux
    // exit without coming back up after the install completes.
    autoUpdater.quitAndInstall(false, true)
  })

  ipcMain.on(UPDATE_OPEN_RELEASE, (_e, url?: string) => {
    const target = url || latestReleaseUrl
    if (target) {
      const version = currentStatus.state === 'manual' ? currentStatus.version : undefined
      void sendEvent('update_manual_open_clicked', { version: version ?? null })
      shell.openExternal(target)
    }
  })

  ipcMain.handle('update:getStatus', () => currentStatus)

  // Don't check for updates in dev mode
  if (!app.isPackaged) return

  // Honor the beta opt-in: when on, the updater also considers GitHub
  // pre-releases (e.g. v1.2.0-beta.1). Off by default so stable users never see
  // staged builds. Re-applied live via setBetaUpdatesEnabled when the toggle
  // flips (see src/main/store.ts → applySettingSideEffect).
  autoUpdater.allowPrerelease = getSettingSync('betaUpdatesEnabled') === true

  log.info('Auto-updater initialized (betas: %s)', autoUpdater.allowPrerelease)

  autoUpdater.on('update-available', (info) => {
    log.info('Update available: v%s', info.version)
    if (currentStatus.state === 'downloading') return
    broadcastStatus({
      state: 'available',
      version: String(info.version),
      canAutoInstall: true,
      prerelease: isPrereleaseVersion(String(info.version)),
    })
  })

  autoUpdater.on('update-not-available', () => {
    log.info('No updates available')
    if (currentStatus.state === 'downloading') return
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
    broadcastStatus({ state: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    const cur = currentStatus
    const version = cur.state === 'downloading' || cur.state === 'available' || cur.state === 'downloaded'
      ? cur.version
      : ''
    const prerelease = cur.state === 'downloading' || cur.state === 'available' || cur.state === 'downloaded'
      ? cur.prerelease
      : undefined
    broadcastStatus({
      state: 'downloading',
      version,
      percent: typeof progress?.percent === 'number' ? progress.percent : undefined,
      prerelease,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded, ready to install')
    broadcastStatus({
      state: 'downloaded',
      version: String(info?.version ?? ''),
      prerelease: isPrereleaseVersion(String(info?.version ?? '')),
    })
  })

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...')
    if (currentStatus.state === 'idle') broadcastStatus({ state: 'checking' })
  })

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err)
    if (currentStatus.state === 'downloading') return
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

  // Check every 15 minutes
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn('[auto-updater] Periodic check threw, trying fallback:', err)
        fallbackCheckForUpdate(false)
      })
    },
    15 * 60 * 1000,
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

/** React to the beta-updates opt-in flipping. Re-points the updater channel
 *  (allowPrerelease) and re-checks immediately so turning betas on surfaces an
 *  available staged build without waiting for the 15-minute poll. Called from
 *  the settings side-effect path (UI toggle AND hand-edited settings.json).
 *  No-op until the app is packaged, since checks don't run in dev. */
export function setBetaUpdatesEnabled(enabled: boolean): void {
  autoUpdater.allowPrerelease = enabled
  log.info('[auto-updater] Beta updates %s', enabled ? 'enabled' : 'disabled')
  if (!app.isPackaged) return
  // A fresh check on the new channel. Don't surface a "no updates" dialog — this
  // is a background reaction to a settings change, not a manual check.
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('[auto-updater] Re-check after beta toggle threw, trying fallback:', err)
    fallbackCheckForUpdate(false)
  })
}
