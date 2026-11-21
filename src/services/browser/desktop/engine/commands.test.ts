import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { createEngineCommands } from './commands'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }))
vi.mock('../downloads', () => ({ GuestDownloads: class {} }))
vi.mock('../dialogs', () => ({ GuestDialogs: class {}, registerGuestDialogs: vi.fn() }))
vi.mock('../pageDriver', () => ({ PageDriverRegistry: class {} }))
vi.mock('../pageLifecycle', () => ({ createPageLifecycle: () => ({}) }))

it('paints a hidden page until its last overlapping operation settles', async () => {
  let painting = true
  let visible = true
  const first = Promise.withResolvers<Electron.NativeImage>()
  const second = Promise.withResolvers<Electron.NativeImage>()
  const page = {
    isDestroyed: () => false,
    isPainting: () => painting,
    startPainting: vi.fn(() => { painting = true }),
    stopPainting: vi.fn(() => { painting = false }),
    capturePage: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  }
  const noop = () => undefined
  const commands = createEngineCommands({
    page: () => page as unknown as WebContents, visible: () => visible,
    nativeId: noop, pageId: noop, ownerId: noop, focused: () => false,
    inputContext: noop, emit: noop, callParent: async () => undefined,
  })

  const a = commands.execute('screenshot', [1], 1)
  const b = commands.execute('screenshot', [1], 1)
  visible = false
  commands.updatePainting(1)
  expect(page.stopPainting).not.toHaveBeenCalled()

  first.resolve({ isEmpty: () => true } as Electron.NativeImage)
  await expect(a).resolves.toBeNull()
  expect(page.stopPainting).not.toHaveBeenCalled()

  second.reject(new Error('capture failed'))
  await expect(b).rejects.toThrow('capture failed')
  expect(page.stopPainting).toHaveBeenCalledOnce()

  visible = true
  commands.updatePainting(1)
  expect(page.startPainting).toHaveBeenCalledOnce()
})
