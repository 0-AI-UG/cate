// =============================================================================
// Native app capture IPC — thin ipcMain.handle wiring over NativeAppBroker.
// See src/main/nativeApp/NativeAppBroker.ts for the session/process logic and
// native/nativehost/PROTOCOL.md for the wire protocol being brokered.
// =============================================================================

import { ipcMain } from 'electron'
import {
  NATIVE_APP_ACQUIRE,
  NATIVE_APP_RELEASE,
  NATIVE_APP_INPUT,
  NATIVE_APP_RESIZE,
} from '../../shared/ipc-channels'
import type { NativeAppAcquireOptions, NativeAppAcquireResult } from '../../shared/types'
import { acquire, release, sendInput, sendResize } from '../nativeApp/NativeAppBroker'
import { windowFromEvent } from '../windowRegistry'
import { wrapHandler } from './handlerError'

export function registerNativeAppHandlers(): void {
  ipcMain.handle(
    NATIVE_APP_ACQUIRE,
    wrapHandler(`[${NATIVE_APP_ACQUIRE}]`, async (event, options: NativeAppAcquireOptions): Promise<NativeAppAcquireResult> => {
      const win = windowFromEvent(event)
      if (!win) return { error: 'no owning window for acquire request' }
      return acquire(options, win.id)
    }),
  )

  ipcMain.handle(
    NATIVE_APP_RELEASE,
    wrapHandler(`[${NATIVE_APP_RELEASE}]`, async (_event, sessionId: string): Promise<void> => {
      await release(sessionId)
    }),
  )

  // Input + resize are high-frequency, fire-and-forget — use `.on` (send) not
  // `.handle` (invoke) to avoid a reply round-trip per event.
  ipcMain.on(NATIVE_APP_INPUT, (_event, sessionId: string, inputEvent: unknown) => {
    sendInput(sessionId, inputEvent)
  })

  ipcMain.on(NATIVE_APP_RESIZE, (_event, sessionId: string, width: number, height: number) => {
    sendResize(sessionId, width, height)
  })
}
