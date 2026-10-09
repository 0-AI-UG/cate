// IPC plumbing for the desktop channels: handlers log and normalize errors,
// and know which window asked.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { createLogger } from '@kernel/log/contract'
import type { DesktopChannel } from '../contract'

const log = createLogger('ipc')

export function handle<A extends unknown[], R>(
  channel: DesktopChannel,
  handler: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as A))
    } catch (error) {
      log.warn('%s failed: %s', channel, error instanceof Error ? error.message : String(error))
      throw error instanceof Error ? error : new Error(String(error))
    }
  })
}

export function listen<A extends unknown[]>(channel: DesktopChannel, handler: (event: IpcMainEvent, ...args: A) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...(args as A))
    } catch (error) {
      log.warn('%s failed: %s', channel, error instanceof Error ? error.message : String(error))
    }
  })
}
