import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  build: vi.fn((_template: import('electron').MenuItemConstructorOptions[]) => ({ items: [] })), set: vi.fn(), send: vi.fn(),
  updates: vi.fn(), external: vi.fn(), settings: {} as Record<string, unknown>,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: mocks.build, setApplicationMenu: mocks.set },
  shell: { openExternal: mocks.external }, app: { name: 'Cate' },
}))
vi.mock('./auto-updater', () => ({ checkForUpdatesManually: mocks.updates }))
vi.mock('./settingsFile', () => ({ getSetting: () => mocks.settings }))
vi.mock('./windowRegistry', () => ({
  getActiveMainWindow: vi.fn(), getFocusedWindow: vi.fn(), sendToWindow: mocks.send,
}))

import { buildApplicationMenu, runNativeAction, setNewMainWindowFn } from './menu'
import { storedShortcut } from '../shared/types'

beforeEach(() => { vi.clearAllMocks(); mocks.settings = {} })

it('scopes native window and browser commands to the requesting window', () => {
  const win = { id: 42, close: vi.fn(), isFullScreen: () => false, setFullScreen: vi.fn(),
    webContents: { reloadIgnoringCache: vi.fn(), toggleDevTools: vi.fn() } } as unknown as import('electron').BrowserWindow
  runNativeAction(win, 'closeWindow')
  runNativeAction(win, 'toggleFullscreen')
  runNativeAction(win, 'reloadWindow')
  runNativeAction(win, 'toggleDevTools')
  runNativeAction(win, 'browser:back')
  expect(win.close).toHaveBeenCalledOnce()
  expect(win.setFullScreen).toHaveBeenCalledWith(true)
  expect(win.webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
  expect(win.webContents.toggleDevTools).toHaveBeenCalledOnce()
  expect(mocks.send).toHaveBeenCalledWith(42, 'browser:shortcut', 'back')
})

it('creates a window through the existing window factory and ignores unknown actions', () => {
  const create = vi.fn()
  setNewMainWindowFn(create as never)
  runNativeAction({} as never, 'newWindow')
  runNativeAction({} as never, 'not-an-action' as never)
  expect(create).toHaveBeenCalledOnce()
})

it('uses customized native bindings and does not restore cleared role defaults', () => {
  mocks.settings = {
    openFolder: storedShortcut('j', { command: true }),
    toggleDevTools: storedShortcut(''),
    skills: storedShortcut('s', { command: true, option: true }),
  }
  buildApplicationMenu()
  const template = mocks.build.mock.calls[0][0] as unknown as import('electron').MenuItemConstructorOptions[]
  const flat = (items: typeof template): typeof template => items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flat(item.submenu) : [])])
  const items = flat(template)
  expect(items.find(item => item.label === 'Open Folder…')?.accelerator).toBe('CmdOrCtrl+j')
  const devtools = items.find(item => item.label === 'Toggle Developer Tools')!
  expect(devtools.accelerator).toBeUndefined()
  expect(devtools.role).toBeUndefined()
  expect(items.find(item => item.label === 'Skills…')?.accelerator).toBe('CmdOrCtrl+Alt+s')
})
