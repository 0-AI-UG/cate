// =============================================================================
// updateInstaller — the single owner of the update *install* sequence.
//
// Why this exists: historically the install path was entangled with the generic
// app quit handlers (before-quit / will-quit) in src/main/index.ts — session
// flush ran twice, the "a terminal is still running" dialog could intercept the
// update quit, and the reallyExit fast-path could bypass Electron's relaunch
// hook. Each was patched separately and the trap kept reappearing.
//
// Now: performUpdateInstall() owns flush → teardown → quitAndInstall, and the
// generic quit handlers simply yield (isUpdateInstalling() === true) because the
// installer already did the work. One path, one owner.
//
// Crucially, on macOS we refuse to *pretend* to self-update when we physically
// cannot (App Translocation / not in /Applications): quitAndInstall would
// silently fail and strand the user on the old version forever. Instead we route
// to the manual-download affordance.
// =============================================================================

import { app } from 'electron'

/** True when electron-updater's quitAndInstall can actually replace the running
 *  bundle. On macOS this is impossible when the app is running translocated
 *  (Gatekeeper App Translocation) or simply not in /Applications — both report
 *  app.isInApplicationsFolder() === false. Other platforms can always self-update.
 *  If the API is unavailable for any reason we return true so we never *block* an
 *  install that might have worked. */
export function canSelfUpdate(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return true
  try {
    return app.isInApplicationsFolder()
  } catch {
    return true
  }
}

/** Arms a timer that calls onTimeout if the process is still alive after `ms`.
 *  Used to detect "quitAndInstall fired but the app never quit/relaunched" so the
 *  UI can recover (offer manual download) instead of hanging on a dead Restart
 *  button. Returns a cancel fn — call it once the install quit is genuinely
 *  proceeding (i.e. from a before-quit that actually fires). */
export function startInstallWatchdog(ms: number, onTimeout: () => void): () => void {
  const t = setTimeout(onTimeout, ms)
  return () => clearTimeout(t)
}

type InstallerStatus =
  | { state: 'manual'; version: string; releaseUrl: string }
  | { state: 'error'; message: string; version?: string; releaseUrl?: string }
  | { state: 'downloaded'; version: string }

export interface InstallDeps {
  platform: NodeJS.Platform
  /** Whether quitAndInstall can actually replace the bundle (see canSelfUpdate). */
  canSelfUpdate: () => boolean
  /** Persist renderer/session state once before we tear down. */
  flushSession: () => Promise<void>
  /** Synchronous, idempotent teardown (state saves, lock release, PTY kill, …). */
  teardown: () => void
  /** electron-updater quitAndInstall(false, true). */
  quitAndInstall: () => void
  /** Push a status to the renderer. */
  broadcast: (s: InstallerStatus) => void
  /** Where to send the user when self-update is impossible. */
  manualReleaseUrl: string
  /** Version we are installing (best-effort, for messaging). */
  version: string
}

let installing = false
/** Read by the generic quit handlers in src/main/index.ts so they yield. */
export function isUpdateInstalling(): boolean { return installing }
/** Test-only reset of module state. */
export function __resetInstallerForTests(): void { installing = false }

/** Owns the full install-quit sequence. Idempotent: a second call while an
 *  install is already underway is a no-op. When self-update is impossible
 *  (macOS translocation / not in /Applications) it broadcasts `manual` and does
 *  NOT quit — the user gets a working manual-download option instead of a dead
 *  Restart. */
export async function performUpdateInstall(deps: InstallDeps): Promise<void> {
  if (installing) return
  if (!deps.canSelfUpdate()) {
    deps.broadcast({ state: 'manual', version: deps.version, releaseUrl: deps.manualReleaseUrl })
    return
  }
  installing = true
  await deps.flushSession()
  deps.teardown()
  deps.quitAndInstall()
}
