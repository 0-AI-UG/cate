// The app updater: stock electron-updater (download in the background, install
// on the next quit), plus three things the silent default path lacks:
//   1. telemetry on every updater event, so failed installs are visible;
//   2. an install-loop detector (./updateState): after repeated silent install
//      failures the user is offered the manual download instead;
//   3. no self-update from outside /Applications on macOS (translocation makes
//      the swap fail); the manual download or a move is offered instead.
// The quit path must not hard-exit while an update is staged (`pendingInstall`).

import type { MessageBoxOptions } from 'electron'
import { createLogger } from '@kernel/log/contract'
import type { UpdateStatus } from '../../contract'
import { decideInstallState, type UpdateRecord } from './updateState'

const log = createLogger('updater')

export const RELEASES_URL = 'https://github.com/0-AI-UG/cate/releases/latest'
const CHECK_INTERVAL_MS = 15 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 5_000

/** The parts of electron-updater's `autoUpdater` used here. */
interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  forceDevUpdateConfig: boolean
  disableDifferentialDownload: boolean
  checkForUpdatesAndNotify(): Promise<unknown>
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: any[]) => void): unknown
}

export interface AutoUpdaterDeps {
  updater: UpdaterLike
  app: { isPackaged: boolean; getVersion(): string; moveToApplicationsFolder(): boolean }
  /** `update-state.json`. */
  state: { get(): UpdateRecord; set(record: UpdateRecord): void }
  track(name: string, props?: Record<string, unknown>): void
  broadcast(status: UpdateStatus): void
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>
  openExternal(url: string): void
  /** False on macOS outside /Applications. */
  canSelfUpdate(): boolean
  betaUpdatesEnabled(): boolean
  /** `CATE_DEV_UPDATE=1`: a local feed in an unpackaged build. */
  devUpdate?: boolean
  setTimeout?: (fn: () => void, ms: number) => unknown
  setInterval?: (fn: () => void, ms: number) => unknown
}

export interface AutoUpdater {
  start(): void
  status(): UpdateStatus
  checkManually(): void
  /** Quits and installs a staged update; false when none is staged. */
  installNow(): boolean
  setBetaUpdates(enabled: boolean): void
  /** An update is downloaded and installs on quit: do not hard-exit. */
  pendingInstall(): boolean
}

const DISABLED: UpdateStatus = { state: 'disabled', version: null, message: 'Updates are available in installed builds of Cate.' }

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return text.trim() ? text.trim() : fallback
}

export function createAutoUpdater(deps: AutoUpdaterDeps): AutoUpdater {
  const { updater } = deps
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const devUpdate = !deps.app.isPackaged && deps.devUpdate === true
  const enabled = deps.app.isPackaged || devUpdate
  // The dev feed never really installs: do not record its install-loop state.
  const persistInstallState = deps.app.isPackaged

  let status: UpdateStatus = enabled ? { state: 'idle', version: null } : DISABLED
  let pendingInstall = false
  let manualPrompted = false
  let manualCheck = false
  let lastProgressBucket = -1
  let checkTracked = false
  let availableVersion: string | null = null
  let inFlight: Promise<unknown> | null = null
  let eligible = true

  const track = (name: string, props?: Record<string, unknown>) => {
    try { deps.track(name, props ?? {}) } catch { /* telemetry never touches the updater */ }
  }

  const push = (next: UpdateStatus) => {
    status = next
    deps.broadcast(manualCheck ? { ...next, manual: true } : next)
    if (['up-to-date', 'downloaded', 'error', 'disabled'].includes(next.state)) manualCheck = false
  }

  const promptManual = async (version: string, offerMove: boolean) => {
    if (manualPrompted) return
    manualPrompted = true
    track('update_manual_fallback_shown', { version: version || null })
    const buttons = offerMove ? ['Download latest', 'Move to Applications', 'Later'] : ['Download latest', 'Later']
    const detail = offerMove
      ? 'Cate is running from outside the Applications folder, so it cannot update itself. Download the latest build, or move Cate into Applications to enable automatic updates.'
      : 'Cate could not finish installing the update automatically. Download and install the latest build to get the newest version.'
    let response = buttons.length - 1
    try {
      ;({ response } = await deps.showMessageBox({
        type: 'info',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        message: version ? `Update available (v${version})` : 'Update available',
        detail,
      }))
    } catch (error) {
      log.warn('manual reinstall dialog failed: %O', error)
      return
    }
    if (response === 0) {
      track('update_manual_fallback_clicked', { version: version || null })
      deps.openExternal(RELEASES_URL)
    } else if (offerMove && response === 1) {
      try { deps.app.moveToApplicationsFolder() } catch (error) { log.error('move to Applications failed: %O', error) }
    }
  }

  // A redundant check after staging re-arms Squirrel.Mac's install-on-quit
  // without relaunch and clears its "ready" flag, so "Restart now" would then
  // install without reopening the app. Never check again once staged.
  const check = (): Promise<unknown> => {
    if (pendingInstall) return Promise.resolve(null)
    if (inFlight) return inFlight
    if (status.state === 'downloading') return Promise.resolve(null)
    push({ state: 'checking', version: availableVersion })
    inFlight = Promise.resolve()
      .then(() => (eligible ? updater.checkForUpdatesAndNotify() : updater.checkForUpdates()))
      .catch((error) => {
        log.warn('check failed: %O', error)
        if (status.state !== 'error') push({ state: 'error', version: availableVersion, message: message(error, 'Could not check for updates. Try again.') })
        return null
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  const wire = () => {
    updater.on('checking-for-update', () => {
      if (!checkTracked) {
        checkTracked = true
        track('update_check_started')
      }
      push({ state: 'checking', version: availableVersion })
    })
    updater.on('update-available', (info: { version?: string } | undefined) => {
      const version = String(info?.version ?? '')
      availableVersion = version || null
      lastProgressBucket = -1
      track('update_available', { version: version || null })
      push({ state: 'available', version: version || null })
      if (!eligible) void promptManual(version, true)
    })
    updater.on('update-not-available', () => {
      availableVersion = null
      push({ state: 'up-to-date', version: null })
    })
    updater.on('download-progress', (progress: { percent?: number } | undefined) => {
      const percent = typeof progress?.percent === 'number' && Number.isFinite(progress.percent) ? progress.percent : 0
      const bucket = Math.min(100, Math.floor(percent / 25) * 25)
      if (bucket > lastProgressBucket) {
        lastProgressBucket = bucket
        track('update_download_progress', { percent: bucket })
      }
      push({ state: 'downloading', version: availableVersion, percent: Math.round(Math.max(0, Math.min(100, percent))) })
    })
    updater.on('update-downloaded', (info: { version?: string } | undefined) => {
      const version = String(info?.version ?? '')
      pendingInstall = true
      if (persistInstallState) {
        // Keep the attempt count when the same version is staged again, or a
        // silent install failure would reset the loop detector every launch.
        const staged = version || null
        const previous = deps.state.get()
        deps.state.set({ pendingVersion: staged, attempts: previous.pendingVersion === staged ? previous.attempts : 0 })
      }
      log.info('update v%s downloaded; installs on quit', version)
      track('update_downloaded', { version: version || null })
      push({ state: 'downloaded', version: version || null })
    })
    updater.on('error', (error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error)
      log.error('updater error: %O', error)
      track('update_error', { message: raw })
      push({ state: 'error', version: availableVersion, message: message(error, 'Update failed. Try again.') })
      // A known update that failed to apply: quit normally and offer the manual
      // download. A bare check failure stays silent.
      if (availableVersion || pendingInstall) {
        pendingInstall = false
        void promptManual(availableVersion ?? '', !eligible)
      }
    })
  }

  const evaluateInstallOutcome = () => {
    const record = deps.state.get()
    const decision = decideInstallState(record, deps.app.getVersion())
    deps.state.set(decision.nextRecord)
    if (decision.kind === 'succeeded') track('update_install_succeeded', { version: deps.app.getVersion() })
    else if (decision.kind === 'retry') log.warn('staged update v%s did not apply (attempt %d)', record.pendingVersion, decision.nextRecord.attempts)
    else if (decision.kind === 'give-up-manual') {
      track('update_install_failed_repeatedly', { version: record.pendingVersion })
      void promptManual(record.pendingVersion ?? '', !deps.canSelfUpdate())
    }
  }

  return {
    start() {
      if (!enabled) {
        push(DISABLED)
        return
      }
      if (devUpdate) updater.forceDevUpdateConfig = true
      updater.allowPrerelease = deps.betaUpdatesEnabled()
      // The repo checkout is never in /Applications; the dev feed always downloads.
      eligible = devUpdate ? true : deps.canSelfUpdate()
      updater.autoDownload = eligible
      updater.autoInstallOnAppQuit = eligible
      // Differential downloads intermittently assembled a corrupt zip on macOS.
      updater.disableDifferentialDownload = true
      wire()
      if (persistInstallState) evaluateInstallOutcome()
      later(() => { void check() }, FIRST_CHECK_DELAY_MS)
      every(() => { void check() }, CHECK_INTERVAL_MS)
    },
    status: () => status,
    checkManually() {
      manualCheck = true
      if (!enabled) {
        push(DISABLED)
        return
      }
      manualPrompted = false
      if (pendingInstall && status.state === 'downloaded') {
        // Re-open a dismissed "update ready" dialog; a one-off, not cached.
        manualCheck = false
        deps.broadcast({ ...status, forceShow: true })
      }
      void check()
    },
    installNow() {
      if (!pendingInstall || !deps.canSelfUpdate()) return false
      track('update_restart_clicked', { version: availableVersion })
      // Quit first, let Squirrel swap the bundle with nothing running, then
      // relaunch. Deferred so the caller's reply goes out before teardown.
      setImmediate(() => updater.quitAndInstall(false, true))
      return true
    },
    setBetaUpdates(on) {
      updater.allowPrerelease = on
      if (deps.app.isPackaged) void check()
    },
    pendingInstall: () => pendingInstall,
  }
}

/** macOS can only replace the running bundle from /Applications (and not
 *  translocated); other platforms always can. */
export function canSelfUpdate(app: { isInApplicationsFolder(): boolean }, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return true
  try { return app.isInApplicationsFolder() } catch { return true }
}
