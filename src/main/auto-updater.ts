// =============================================================================
// Auto-updater — stock electron-updater, no custom UI.
//
// Behaviour (the library's defaults):
//   • autoDownload         — a found update downloads in the background
//   • autoInstallOnAppQuit — the downloaded update installs the next time the
//                            app quits normally; the user reopens on the new
//                            version. No in-app button, no forced restart.
//   • checkForUpdatesAndNotify — shows the native OS notification when an update
//                            has downloaded and is ready to install.
//
// Two things the defaults DON'T handle, which we must:
//   1. macOS App Translocation / not-in-/Applications: quitAndInstall silently
//      cannot replace the bundle from there, so we (a) disable self-update when
//      ineligible — never download a ~600MB asset that can't apply — and (b)
//      prompt the user to move Cate into /Applications when an update exists,
//      which is the only way they get unstuck. See canSelfUpdate().
//   2. The app's will-quit fast-path calls process.reallyExit(0), which would
//      bypass electron-updater's on-quit installer. src/main/index.ts reads
//      isUpdatePendingInstall() and skips reallyExit when an update is staged so
//      the install actually runs. (This was a silent killer of the default path.)
// =============================================================================

import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from './logger'
import { getSettingSync } from './store'
import { canSelfUpdate } from './updateInstaller'

/** True once an update has finished downloading and is queued to install on the
 *  next quit. Read by the will-quit handler in src/main/index.ts so it does NOT
 *  process.reallyExit(0) — that would bypass electron-updater's install-on-quit
 *  hook and the update would never apply. */
let updatePendingInstall = false
export function isUpdatePendingInstall(): boolean { return updatePendingInstall }

/** Prompt-once-per-launch guard so the move-to-/Applications dialog doesn't nag
 *  on every 15-minute poll. Reset on an explicit "Check for Updates…". */
let movePrompted = false

function promptMoveToApplications(version: string): void {
  if (movePrompted) return
  movePrompted = true
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['Move to Applications', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: version ? `Update available (v${version})` : 'Update available',
    detail:
      'Cate can’t update itself because it’s running from outside the Applications folder ' +
      '(macOS blocks self-updates there). Move Cate to Applications to enable automatic updates. ' +
      'Your settings and sessions are preserved.',
  })
  if (choice === 0) {
    try {
      app.moveToApplicationsFolder() // moves the bundle and relaunches
    } catch (err) {
      log.error('[auto-updater] moveToApplicationsFolder failed: %O', err)
    }
  }
}

/** Run a check. When eligible, AndNotify downloads (autoDownload) and shows the
 *  native "ready to install" notification; when ineligible we only check so the
 *  update-available handler can offer the move-to-/Applications path. */
function runCheck(eligible: boolean): Promise<unknown> {
  const p = eligible ? autoUpdater.checkForUpdatesAndNotify() : autoUpdater.checkForUpdates()
  return p.catch((err) => {
    log.warn('[auto-updater] check failed: %O', err)
    return null
  })
}

const CHECK_INTERVAL_MS = 15 * 60 * 1000

export function initAutoUpdater(): void {
  if (!app.isPackaged) return

  // Honor the beta opt-in (Settings → Updates). Re-applied live via
  // setBetaUpdatesEnabled when the toggle flips.
  autoUpdater.allowPrerelease = getSettingSync('betaUpdatesEnabled') === true

  autoUpdater.on('update-downloaded', (info) => {
    updatePendingInstall = true
    log.info('[auto-updater] Update downloaded: v%s — will install on quit', String(info?.version ?? ''))
  })
  autoUpdater.on('error', (err) => {
    log.error('[auto-updater] error: %O', err)
  })

  const eligible = canSelfUpdate()
  autoUpdater.autoDownload = eligible
  autoUpdater.autoInstallOnAppQuit = eligible

  if (!eligible) {
    // macOS, running translocated / outside /Applications. Don't download what
    // can't install; instead, when an update actually exists, offer the move.
    autoUpdater.on('update-available', (info) => promptMoveToApplications(String(info?.version ?? '')))
    log.info('[auto-updater] self-update unavailable from current location (will prompt to move on update)')
  } else {
    log.info('[auto-updater] initialized (betas: %s)', autoUpdater.allowPrerelease)
  }

  // Check on launch (slightly delayed so it doesn't compete with cold start) and
  // every 15 minutes thereafter.
  setTimeout(() => void runCheck(eligible), 5000)
  setInterval(() => void runCheck(eligible), CHECK_INTERVAL_MS)
}

/** Wired to the "Check for Updates…" menu items. Re-allows the move prompt since
 *  the user explicitly asked. No "you're up to date" dialog by design (zero
 *  custom UI) — a pending update surfaces via the OS notification / move prompt. */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) return
  movePrompted = false
  void runCheck(canSelfUpdate())
}

/** React to the beta-updates opt-in flipping (UI toggle or hand-edited
 *  settings.json): re-point the channel and re-check immediately. */
export function setBetaUpdatesEnabled(enabled: boolean): void {
  autoUpdater.allowPrerelease = enabled
  log.info('[auto-updater] Beta updates %s', enabled ? 'enabled' : 'disabled')
  if (!app.isPackaged) return
  void runCheck(canSelfUpdate())
}
