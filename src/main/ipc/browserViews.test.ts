import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: any[]) => any

const h = vi.hoisted(() => {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  let owner: any = null
  let nextId = 100
  const guests: any[] = []

  function emitter() {
    const events = new Map<string, Listener[]>()
    return {
      on: vi.fn((name: string, listener: Listener) => {
        events.set(name, [...(events.get(name) ?? []), listener])
      }),
      once: vi.fn((name: string, listener: Listener) => {
        const wrapped: Listener = (...args) => {
          events.set(name, (events.get(name) ?? []).filter((item) => item !== wrapped))
          listener(...args)
        }
        events.set(name, [...(events.get(name) ?? []), wrapped])
      }),
      emit: (name: string, ...args: any[]) => {
        for (const listener of [...(events.get(name) ?? [])]) listener(...args)
      },
      isDestroyed: vi.fn(() => false),
    }
  }

  function guest() {
    const contents = {
      ...emitter(),
      id: nextId++,
      session: {},
      getURL: vi.fn(() => 'about:blank'),
      getTitle: vi.fn(() => ''),
      isLoading: vi.fn(() => false),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
      },
      close: vi.fn(),
    }
    guests.push(contents)
    return contents
  }

  return {
    handlers,
    listeners,
    guests,
    emitter,
    guest,
    setOwner: (next: any) => { owner = next },
    getOwner: () => owner,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => h.getOwner() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Listener) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: Listener) => h.listeners.set(channel, listener)),
  },
  session: { fromPartition: vi.fn(() => ({})) },
  WebContentsView: class {
    webContents = h.guest()
    setBackgroundColor = vi.fn()
    setVisible = vi.fn()
    setBounds = vi.fn()
  },
}))
vi.mock('./handlerError', () => ({ wrapHandler: (_label: string, handler: Listener) => handler }))
vi.mock('../webSecurity', () => ({
  configureBrowserGuestSession: vi.fn(),
  getBrowserGuestPreloadPath: vi.fn(() => '/tmp/preload.js'),
  installBrowserGuestContents: vi.fn(),
}))
vi.mock('./browserControl', () => ({ watchDownloadsForSession: vi.fn() }))
vi.mock('../browser/browserViewOwnership', () => ({
  registerBrowserViewOwner: vi.fn(),
  unregisterBrowserViewOwner: vi.fn(),
}))

import {
  BROWSER_VIEW_BOUNDS,
  BROWSER_VIEW_CREATE,
} from '../../shared/ipc-channels'
import { registerBrowserViewHandlers } from './browserViews'

describe('native browser view ownership', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.listeners.clear()
    h.guests.length = 0
  })

  it('forwards modifier-wheel zoom and destroys views when the owner renderer is replaced', async () => {
    const ownerContents = {
      ...h.emitter(),
      send: vi.fn(),
      sendInputEvent: vi.fn(),
    }
    const owner = {
      ...h.emitter(),
      id: 7,
      webContents: ownerContents,
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    }
    h.setOwner(owner)
    registerBrowserViewHandlers()

    const create = h.handlers.get(BROWSER_VIEW_CREATE)!
    const state = await create(
      { sender: ownerContents },
      { panelId: 'browser-1', partition: 'persist:browser-shared' },
    )
    const guest = h.guests[0]
    h.listeners.get(BROWSER_VIEW_BOUNDS)?.(
      { sender: ownerContents },
      'browser-1',
      state.webContentsId,
      {
        rect: { x: 100, y: 50, width: 400, height: 300 },
        rendererSize: { width: 800, height: 600 },
        visible: true,
        zoomFactor: 1,
      },
    )

    const prevented = vi.fn()
    guest.emit('before-mouse-event', { preventDefault: prevented }, {
      type: 'mouseWheel',
      x: 20,
      y: 30,
      deltaY: -12,
      modifiers: ['meta'],
    })
    expect(prevented).toHaveBeenCalledTimes(1)
    expect(ownerContents.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mouseWheel',
      x: 120,
      y: 80,
      deltaY: -12,
      modifiers: ['meta'],
    }))

    const plainPrevented = vi.fn()
    guest.emit('before-mouse-event', { preventDefault: plainPrevented }, {
      type: 'mouseWheel', x: 20, y: 30, deltaY: 12, modifiers: [],
    })
    expect(plainPrevented).not.toHaveBeenCalled()

    ownerContents.emit('did-start-navigation', {}, 'file:///renderer.html', false, true)
    expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(guest.close).toHaveBeenCalledTimes(1)

    await create(
      { sender: ownerContents },
      { panelId: 'browser-1', partition: 'persist:browser-shared' },
    )
    const replacement = h.guests[1]
    ownerContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(owner.contentView.removeChildView).toHaveBeenCalledTimes(2)
    expect(replacement.close).toHaveBeenCalledTimes(1)
  })
})
