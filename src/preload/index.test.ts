import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../shared/electron-api'
import {
  DIALOG_SAVE_FILE,
  DIALOG_TERMINAL_LINK_OPEN,
  KEEP_AWAKE_TOGGLE,
  MENU_POPUP_BAR_ITEM,
  TERMINAL_DATA,
  TERMINAL_RESIZE,
} from '../shared/ipc-channels'

type IpcListener = (event: unknown, ...args: unknown[]) => void

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<IpcListener>>()
  const on = vi.fn((channel: string, listener: IpcListener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>()
    channelListeners.add(listener)
    listeners.set(channel, channelListeners)
  })
  const removeListener = vi.fn((channel: string, listener: IpcListener) => {
    listeners.get(channel)?.delete(listener)
  })

  return {
    exposeInMainWorld: vi.fn(),
    getPathForFile: vi.fn(),
    invoke: vi.fn(),
    listeners,
    on,
    removeListener,
    send: vi.fn(),
    sendSync: vi.fn(),
    setZoomFactor: vi.fn(),
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
    send: electron.send,
    sendSync: electron.sendSync,
  },
  webFrame: { setZoomFactor: electron.setZoomFactor },
  webUtils: { getPathForFile: electron.getPathForFile },
}))

let api: ElectronAPI

function emit(channel: string, ...args: unknown[]): void {
  for (const listener of [...(electron.listeners.get(channel) ?? [])]) {
    listener({ sender: 'main' }, ...args)
  }
}

beforeAll(async () => {
  await import('./index')
  api = electron.exposeInMainWorld.mock.calls[0][1] as ElectronAPI
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('electronAPI preload bridge', () => {
  it('exposes the keep-awake toggle and returns its IPC result', async () => {
    electron.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    expect(await api.toggleKeepAwake()).toBe(true)
    expect(await api.toggleKeepAwake()).toBe(false)
    expect(electron.invoke.mock.calls).toEqual([
      [KEEP_AWAKE_TOGGLE],
      [KEEP_AWAKE_TOGGLE],
    ])
  })

  it('forwards invoke arguments and returns the original IPC promise', () => {
    const ipcResult = Promise.resolve('done')
    electron.invoke.mockReturnValueOnce(ipcResult)

    const result = api.terminalResize('terminal-1', 120, 40)

    expect(electron.invoke).toHaveBeenCalledWith(TERMINAL_RESIZE, 'terminal-1', 120, 40)
    expect(result).toBe(ipcResult)
  })

  it('keeps transformed dialog and menu payloads on their wire contracts', () => {
    api.saveFileDialog()
    api.promptTerminalLinkOpen('https://example.test/docs')
    api.popupAppMenu(2, 18, 34)

    expect(electron.invoke.mock.calls).toEqual([
      [DIALOG_SAVE_FILE, {}],
      [DIALOG_TERMINAL_LINK_OPEN, { url: 'https://example.test/docs' }],
      [MENU_POPUP_BAR_ITEM, { index: 2, x: 18, y: 34 }],
    ])
  })

  it('isolates subscriptions and removes only the listener being unsubscribed', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = api.onTerminalData(first)
    const unsubscribeSecond = api.onTerminalData(second)

    emit(TERMINAL_DATA, 'terminal-1', 'hello')
    expect(first).toHaveBeenCalledWith('terminal-1', 'hello')
    expect(second).toHaveBeenCalledWith('terminal-1', 'hello')

    unsubscribeFirst()
    emit(TERMINAL_DATA, 'terminal-1', ' again')

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith('terminal-1', ' again')
    expect(electron.listeners.get(TERMINAL_DATA)).toHaveLength(1)

    unsubscribeSecond()
    expect(electron.listeners.get(TERMINAL_DATA)).toHaveLength(0)
  })

  it('delegates dropped-file path lookup to Electron webUtils', () => {
    const file = { name: 'notes.txt' } as File
    electron.getPathForFile.mockReturnValue('/tmp/notes.txt')

    expect(api.getPathForFile(file)).toBe('/tmp/notes.txt')
    expect(electron.getPathForFile).toHaveBeenCalledWith(file)
  })

  it.each([
    [0.25, 0.5],
    [1.25, 1.25],
    [3, 2],
    [Number.NaN, 1],
  ])('clamps UI scale %s to %s', (input, expected) => {
    api.setUiScale(input)

    expect(electron.setZoomFactor).toHaveBeenCalledWith(expected)
  })
})
