import { BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import { setSettingsFromMain } from '../store'
import { trackAppStart, checkAndReportUpdate } from '../analytics'
import { TELEMETRY_ACKNOWLEDGE_NOTICE } from '../../shared/ipc-channels'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'

// Fire the first-run/version-change analytics + app_start. Telemetry is always
// on in packaged builds; the sends themselves are gated inside analytics.ts
// (dev/E2E builds never send), so there is nothing to defer here anymore.
export function fireStartupTelemetry(mainWin: BrowserWindow): void {
  checkAndReportUpdate(mainWin).catch((err) => log.warn('Update detection failed:', err))
  trackAppStart()
}

// The renderer's telemetry notice (WelcomeDialog) was dismissed — record which
// notice version the user has seen so it isn't shown again until the constant
// is bumped. Purely informational; telemetry does not depend on it.
export function registerTelemetryNoticeHandler(): void {
  ipcMain.handle(TELEMETRY_ACKNOWLEDGE_NOTICE, async () => {
    await setSettingsFromMain({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION })
  })
}
