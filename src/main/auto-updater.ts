// =============================================================================
// Auto-updater — stock electron-updater, reliability-first.
//
// Behaviour (the library's defaults):
//   • autoDownload         — a found update downloads in the background
//   • autoInstallOnAppQuit — the downloaded update installs the next time the
//                            app quits normally; the user reopens on the new
//                            version. No in-app button, no forced restart.
//   • checkForUpdatesAndNotify — shows the native OS notification when an update
//                            has downloaded and is ready to install.
//
// On top of the defaults we add three things, because the silent default path
// gave us no way to see — or recover from — a failed install:
//   1. Telemetry on EVERY updater event (check / available / progress /
//      downloaded / error) so we can see where real installs die. `update_error`
//      is the key signal a Squirrel.Mac swap or signature check failed.
//   2. An install-loop detector (./updateState): we persist the version we
//      staged and, on each launch, check whether we actually advanced. After
//      MAX_INSTALL_ATTEMPTS silent failures we stop trusting the auto path and
//      surface a manual-reinstall prompt — the escape hatch for "trapped" users.
//   3. macOS App Translocation / not-in-/Applications: quitAndInstall silently
//      cannot replace the bundle from there, so we disable self-update when
//      ineligible and offer the manual download (or a move to /Applications).
//
// One thing the host app must still honour: src/main/index.ts's will-quit
// fast-path calls process.reallyExit(0), which would bypass electron-updater's
// on-quit installer. It reads isUpdatePendingInstall() and skips reallyExit when
// an update is staged so the install actually runs. (This was a silent killer of
// the default path.)
// =============================================================================

import { app, dialog, shell, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from './logger'
import { getSettingSync } from './store'
import { sendEvent } from './analytics'
import { canSelfUpdate } from './updateInstaller'
import { createJsonStateFile } from './jsonStateFile'
import { broadcastToAll } from './windowRegistry'
import { UPDATE_STATUS, UPDATE_QUIT_AND_INSTALL, UPDATE_GET_STATUS } from '../shared/ipc-channels'
import type { UpdateStatus } from '../shared/electron-api'
import {
  decideInstallState,
  normalizeUpdateRecord,
  DEFAULT_UPDATE_RECORD,
  type UpdateRecord,
} from './updateState'

const GITHUB_OWNER = '0-AI-UG'
const GITHUB_REPO = 'cate'
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/** Persisted "what did we last stage, and how often has it failed to apply"
 *  record. Backs the install-loop detector. Hand-editable JSON under userData. */
const updateStateStore = createJsonStateFile<UpdateRecord>({
  filename: 'update-state.json',
  defaults: DEFAULT_UPDATE_RECORD,
  normalize: normalizeUpdateRecord,
})

/** True once an update has finished downloading and is queued to install on the
 *  next quit. Read by the will-quit handler in src/main/index.ts so it does NOT
 *  process.reallyExit(0) — that would bypass electron-updater's install-on-quit
 *  hook and the update would never apply. */
let updatePendingInstall = false
export function isUpdatePendingInstall(): boolean { return updatePendingInstall }

/** Prompt-once-per-launch guard for the manual-reinstall dialog so it doesn't
 *  nag on every 15-minute poll. Reset on an explicit "Check for Updates…". */
let manualPrompted = false

/** Last download-progress bucket we reported, so we emit telemetry at
 *  0/25/50/75/100% milestones instead of on every progress tick. */
let lastProgressBucket = -1

/** Whether we've already tracked an `update_check_started` this session. The
 *  updater checks on launch AND every 15 minutes, so tracking every check turns
 *  the event into an uptime heartbeat that swamps real user-action events in
 *  analytics. Collapse it to once per process — enough to count "sessions that
 *  checked" without the 15-minute noise. */
let checkStartedTracked = false

/** Version of the update found this session (set on update-available), so an
 *  `error` event can tell "a known update failed to apply" (→ offer the manual
 *  download) apart from a transient check failure (→ stay silent). */
let availableVersion: string | null = null

/** Whether to persist + evaluate the install-loop record. Only meaningful for a
 *  real packaged install — the dev harness (CATE_DEV_UPDATE) serves a dummy feed
 *  that can't actually install, so recording its "pending v99.0.0" would wrongly
 *  nag on the next normal `npm run dev`. */
let persistInstallState = false

/** Fire-and-forget analytics; never let a telemetry failure touch the updater. */
function track(name: string, props?: Record<string, unknown>): void {
  void sendEvent(name, props ?? {}).catch(() => {})
}

/** Latest status pushed to the renderer. Cached so a window that mounts AFTER
 *  the download-finished event can pull the current state (UPDATE_GET_STATUS)
 *  and still show the "update ready" modal. */
let lastStatus: UpdateStatus = { state: 'idle', version: null }

/** Broadcast an updater status change to every renderer window and cache it.
 *  Drives the in-app "update ready" modal (see UpdateReadyDialog.tsx). */
function pushStatus(status: UpdateStatus): void {
  lastStatus = status
  broadcastToAll(UPDATE_STATUS, status)
}

/** Register the renderer-facing IPC for the in-app update modal. Called once at
 *  startup, BEFORE the dev/packaged gate, so the renderer's invoke() calls never
 *  reject — in dev/unpackaged the updater simply never emits a 'downloaded'
 *  status, so the modal stays hidden. */
function registerUpdateIpc(): void {
  ipcMain.handle(UPDATE_GET_STATUS, (): UpdateStatus => lastStatus)
  ipcMain.handle(UPDATE_QUIT_AND_INSTALL, (): boolean => {
    if (!updatePendingInstall || !canSelfUpdate()) return false
    track('update_restart_clicked', { version: availableVersion })
    // quitAndInstall quits the app, lets Squirrel.Mac swap the bundle while
    // NOTHING is running, then relaunches the new version itself. That avoids
    // the failure we hit with autoInstallOnAppQuit: a fast manual reopen racing
    // the swap and triggering Squirrel's "App Still Running" abort. Defer past
    // this IPC reply so the renderer gets `true` before the app tears down.
    // isForceRunAfter=true guarantees the relaunch.
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })
}

/** The manual-reinstall escape hatch. Shown when self-update genuinely cannot
 *  apply (translocated / not in /Applications, or repeated silent install
 *  failures). Offers the reliable path — download the latest from the website —
 *  and, when running from outside /Applications, a move into it. Once per launch. */
async function promptManualReinstall(version: string, opts: { offerMove: boolean }): Promise<void> {
  if (manualPrompted) return
  manualPrompted = true
  track('update_manual_fallback_shown', { version: version || null })

  const buttons = opts.offerMove
    ? ['Download latest', 'Move to Applications', 'Later']
    : ['Download latest', 'Later']
  const detail = opts.offerMove
    ? 'Cate is running from outside the Applications folder, so it can’t update itself ' +
      '(macOS blocks self-updates there). Download the latest build, or move Cate into ' +
      'Applications to enable automatic updates. Your settings and sessions are preserved.'
    : 'Cate couldn’t finish installing the update automatically. Download and install the ' +
      'latest build to get the newest version. Your settings and sessions are preserved.'

  let response = buttons.length - 1
  try {
    ;({ response } = await dialog.showMessageBox({
      type: 'info',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      message: version ? `Update available (v${version})` : 'Update available',
      detail,
    }))
  } catch (err) {
    log.warn('[auto-updater] manual-reinstall dialog failed: %O', err)
    return
  }

  if (response === 0) {
    track('update_manual_fallback_clicked', { version: version || null })
    void shell.openExternal(RELEASES_URL)
  } else if (opts.offerMove && response === 1) {
    try {
      app.moveToApplicationsFolder() // moves the bundle and relaunches
    } catch (err) {
      log.error('[auto-updater] moveToApplicationsFolder failed: %O', err)
    }
  }
}

/** Run a check. When eligible, AndNotify downloads (autoDownload) and shows the
 *  native "ready to install" notification; when ineligible we only check so the
 *  update-available handler can offer the manual path. */
function runCheck(eligible: boolean): Promise<unknown> {
  const p = eligible ? autoUpdater.checkForUpdatesAndNotify() : autoUpdater.checkForUpdates()
  return p.catch((err) => {
    log.warn('[auto-updater] check failed: %O', err)
    return null
  })
}

/** Attach telemetry + behaviour to every electron-updater event. `eligible`
 *  decides whether an available update auto-downloads or routes to the manual
 *  fallback (translocated mac). */
function wireUpdaterEvents(eligible: boolean): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('[auto-updater] checking for update')
    if (!checkStartedTracked) {
      checkStartedTracked = true
      track('update_check_started')
    }
    pushStatus({ state: 'checking', version: availableVersion })
  })

  autoUpdater.on('update-available', (info) => {
    const version = String(info?.version ?? '')
    availableVersion = version || null
    lastProgressBucket = -1
    log.info('[auto-updater] update available: v%s (eligible: %s)', version, eligible)
    track('update_available', { version: version || null })
    pushStatus({ state: 'available', version: version || null })
    if (!eligible) {
      // Translocated / not in /Applications — can't self-update from here. Offer
      // the manual download (and the move, which would fix it permanently).
      void promptManualReinstall(version, { offerMove: true })
    }
  })

  autoUpdater.on('update-not-available', (info) => {
    // This check found nothing, so a later `error` is a transient check failure,
    // not a known-update-failed-to-apply — drop the session's available-version
    // marker so the error handler stays silent (a still-staged install is
    // tracked separately via updatePendingInstall, which it also honors).
    availableVersion = null
    log.info('[auto-updater] no update available (current v%s)', String(info?.version ?? app.getVersion()))
  })

  autoUpdater.on('download-progress', (p) => {
    const percent = typeof p?.percent === 'number' ? p.percent : 0
    const bucket = Math.min(100, Math.floor(percent / 25) * 25)
    if (bucket > lastProgressBucket) {
      lastProgressBucket = bucket
      log.info('[auto-updater] download progress ~%d%%', bucket)
      track('update_download_progress', { percent: bucket })
      pushStatus({ state: 'downloading', version: availableVersion, percent: bucket })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    const version = String(info?.version ?? '')
    updatePendingInstall = true
    if (persistInstallState) {
      // Preserve the failed-attempt count when re-staging the SAME version. A
      // silent install failure re-downloads the same update every launch, so
      // zeroing attempts here would reset the install-loop detector before it
      // could ever reach MAX_INSTALL_ATTEMPTS — making the give-up → manual-
      // fallback path unreachable in exactly the trap it exists to catch. Only a
      // genuinely new version (different from what's recorded) starts over at 0.
      const staged = version || null
      const prev = updateStateStore.get()
      const attempts = prev.pendingVersion === staged ? prev.attempts : 0
      updateStateStore.set({ pendingVersion: staged, attempts })
    }
    log.info('[auto-updater] update downloaded: v%s — will install on quit', version)
    track('update_downloaded', { version: version || null })
    // The signal the in-app modal acts on: offer Restart now / Install on quit.
    pushStatus({ state: 'downloaded', version: version || null })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message || String(err)
    log.error('[auto-updater] error: %O', err)
    track('update_error', { message })
    pushStatus({ state: 'error', version: availableVersion })
    // If a known update failed (e.g. Squirrel.Mac "ditto: Couldn't read PKZip
    // signature" — a signing/staging failure, the classic trapped-user cause),
    // the staged install won't apply: drop the pending flag so quit takes the
    // normal path, and offer the reliable manual download. A bare check error
    // (no update found, nothing staged this session) stays silent.
    if (availableVersion || updatePendingInstall) {
      updatePendingInstall = false
      void promptManualReinstall(availableVersion ?? '', { offerMove: !eligible })
    }
  })
}

/** On launch, reconcile the persisted "staged update" record against the version
 *  we actually came up on. Success clears the record; repeated failure means the
 *  auto path is broken on this machine, so we route to the manual fallback. */
function evaluateInstallOutcome(): void {
  const record = updateStateStore.get()
  const decision = decideInstallState(record, app.getVersion())
  updateStateStore.set(decision.nextRecord)
  switch (decision.kind) {
    case 'succeeded':
      log.info('[auto-updater] previous update installed successfully (now v%s)', app.getVersion())
      track('update_install_succeeded', { version: app.getVersion() })
      break
    case 'retry':
      log.warn('[auto-updater] staged update v%s did not apply (attempt %d) — will retry',
        record.pendingVersion, decision.nextRecord.attempts)
      break
    case 'give-up-manual':
      log.error('[auto-updater] staged update v%s failed to install repeatedly — offering manual reinstall',
        record.pendingVersion)
      track('update_install_failed_repeatedly', { version: record.pendingVersion })
      void promptManualReinstall(record.pendingVersion ?? '', { offerMove: !canSelfUpdate() })
      break
    case 'none':
      break
  }
}

export function initAutoUpdater(): void {
  // Dev gate. Normally the updater only runs in a packaged build. The dev
  // harness (CATE_DEV_UPDATE=1, see scripts/dev-update.mjs) opts in so a
  // developer can watch the real check → download → downloaded chain against a
  // local feed without cutting a GitHub release.
  const devUpdate = !app.isPackaged && process.env.CATE_DEV_UPDATE === '1'
  // Register the modal IPC before the gate so renderer invoke() never rejects.
  registerUpdateIpc()
  if (!app.isPackaged && !devUpdate) return
  if (devUpdate) {
    autoUpdater.forceDevUpdateConfig = true
    log.info('[auto-updater] DEV UPDATE mode — using local feed (dev-app-update.yml)')
  }
  // Only a real packaged install can actually apply; the dev harness serves a
  // dummy feed, so don't record/evaluate its install-loop state.
  persistInstallState = app.isPackaged

  // Honor the beta opt-in (Settings → Updates). Re-applied live via
  // setBetaUpdatesEnabled when the toggle flips.
  autoUpdater.allowPrerelease = getSettingSync('betaUpdatesEnabled') === true

  // In the dev harness we always want the download to run (the repo checkout is
  // never in /Applications, which would otherwise mark it ineligible).
  const eligible = devUpdate ? true : canSelfUpdate()
  autoUpdater.autoDownload = eligible
  autoUpdater.autoInstallOnAppQuit = eligible

  // Always download the full zip — never the blockmap-based differential. On
  // macOS a differential download intermittently assembled a corrupt zip whose
  // extracted bundle was missing files (the "ditto: …/Electron Framework: No
  // such file or directory" install failure that dropped users into the manual
  // fallback). The full download is a little more bandwidth but it's the
  // reliable path; the Squirrel.Mac swap is fragile enough without feeding it a
  // mis-assembled archive.
  autoUpdater.disableDifferentialDownload = true

  wireUpdaterEvents(eligible)

  if (eligible) {
    log.info('[auto-updater] initialized (betas: %s)', autoUpdater.allowPrerelease)
  } else {
    log.info('[auto-updater] self-update unavailable from current location (will offer manual download on update)')
  }

  // Reconcile any previously-staged update before we kick off new checks.
  // (Skipped in the dev harness — its dummy feed never really installs.)
  if (persistInstallState) evaluateInstallOutcome()

  // Check on launch (slightly delayed so it doesn't compete with cold start) and
  // every 15 minutes thereafter.
  setTimeout(() => void runCheck(eligible), 5000)
  setInterval(() => void runCheck(eligible), CHECK_INTERVAL_MS)
}

/** Wired to the "Check for Updates…" menu items. Re-arms the manual prompt since
 *  the user explicitly asked. No "you're up to date" dialog by design — a pending
 *  update surfaces via the OS notification / manual fallback. */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) return
  manualPrompted = false
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
