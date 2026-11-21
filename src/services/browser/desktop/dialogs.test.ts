import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: {} }))
import { GuestDialogs } from './dialogs'

it('cancels a closing page dialog even when its synchronous IPC reply is disposed', () => {
  const emit = vi.fn()
  const dialogs = new GuestDialogs(emit)
  const page = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false })
  dialogs.open(page as never, { type: 'confirm', message: 'Continue?' }, () => { throw new Error('Frame disposed') })
  expect(dialogs.current(12)?.type).toBe('confirm')
  expect(() => page.emit('destroyed')).not.toThrow()
  expect(dialogs.current(12)).toBeUndefined()
  expect(emit).toHaveBeenLastCalledWith({ webContentsId: 12, dialog: null })
})
