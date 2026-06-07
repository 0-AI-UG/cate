// =============================================================================
// updateInstaller — macOS self-update eligibility.
//
// electron-updater's quitAndInstall / autoInstallOnAppQuit silently CANNOT
// replace the running bundle on macOS when the app is translocated (Gatekeeper
// App Translocation) or simply not in /Applications. We use this to disable
// self-update in that situation (so we never download a ~600MB asset that can't
// apply) and to drive the move-to-/Applications prompt in ./auto-updater.
// =============================================================================

import { app } from 'electron'

/** True when electron-updater can actually replace the running bundle. On macOS
 *  this requires the app to live in /Applications and not be translocated — both
 *  cases report app.isInApplicationsFolder() === false. Other platforms can
 *  always self-update. If the API is unavailable we return true so we never
 *  *block* an install that might have worked. */
export function canSelfUpdate(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return true
  try {
    return app.isInApplicationsFolder()
  } catch {
    return true
  }
}
