import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_OPEN_URL, APP_OPEN_URL_READY } from '../../shared/ipc-channels'

const state = vi.hoisted(() => ({
  app: null as unknown as EventEmitter & { isReady: () => boolean },
  ipc: null as unknown as EventEmitter,
  active: null as any,
  send: vi.fn(),
  focus: vi.fn(),
}))
vi.mock('electron', () => ({ get app() { return state.app }, get ipcMain() { return state.ipc } }))
vi.mock('../windows/reveal', () => ({ IS_E2E: false }))
vi.mock('../windowRegistry', () => ({
  getActiveMainWindow: () => state.active,
  getWindowType: (id: number) => id === 99 ? 'dock' : 'main',
  windowFromEvent: (event: any) => event.win,
  sendToWindow: state.send,
  focusWindow: state.focus,
}))
import { registerOpenUrlHandler } from './openUrl'

function windowFixture(id = 1) {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {} })
  const win = { id, webContents: contents, isDestroyed: () => false }
  const event = { win, sender: contents, senderFrame: contents.mainFrame }
  return { win, event }
}
function open(url: string) {
  const event = { preventDefault: vi.fn() }
  state.app.emit('open-url', event, url)
  expect(event.preventDefault).toHaveBeenCalledOnce()
}

beforeEach(() => {
  state.app = Object.assign(new EventEmitter(), { isReady: () => false })
  state.ipc = new EventEmitter()
  state.active = null
  vi.clearAllMocks()
})

describe('macOS web URL delivery', () => {
  it('queues cold-launch URLs in order until the restored renderer subscribes', () => {
    const create = vi.fn()
    registerOpenUrlHandler(create)
    open('https://example.com/login?next=%2Fdocs#section')
    open('http://localhost:8080/test')
    state.app.isReady = () => true
    open('https://example.com/during-bootstrap')
    expect(create).not.toHaveBeenCalled()
    const { win, event } = windowFixture()
    state.active = win
    expect(state.send).not.toHaveBeenCalled()
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    expect(state.send.mock.calls).toEqual([
      [1, APP_OPEN_URL, 'https://example.com/login?next=%2Fdocs#section'],
      [1, APP_OPEN_URL, 'http://localhost:8080/test'],
      [1, APP_OPEN_URL, 'https://example.com/during-bootstrap'],
    ])
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    expect(state.send).toHaveBeenCalledTimes(3)
  })

  it('delivers warm opens and queues again during renderer reload', () => {
    registerOpenUrlHandler(vi.fn())
    const { win, event } = windowFixture()
    state.active = win
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    open('https://example.com/one')
    expect(state.send).toHaveBeenCalledTimes(1)
    win.webContents.emit('did-start-loading')
    open('https://example.com/two')
    expect(state.send).toHaveBeenCalledTimes(1)
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    expect(state.send).toHaveBeenLastCalledWith(1, APP_OPEN_URL, 'https://example.com/two')
    expect(state.focus).toHaveBeenCalledWith(win)
  })

  it('opens a main window when only detached windows remain', () => {
    state.app.isReady = () => true
    const { win, event } = windowFixture()
    const create = vi.fn(() => { state.active = win; return win })
    registerOpenUrlHandler(create as never)
    state.ipc.emit(APP_OPEN_URL_READY, windowFixture(2).event, true)
    open('https://example.com/')
    expect(create).toHaveBeenCalledOnce()
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    expect(state.send).toHaveBeenCalledOnce()
  })

  it('rejects non-web URLs and readiness from guests, subframes, and dock windows', () => {
    registerOpenUrlHandler(vi.fn())
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'cate://run', 'not a URL']) open(url)
    const { win, event } = windowFixture()
    state.active = win
    open('https://example.com/')
    state.ipc.emit(APP_OPEN_URL_READY, { ...event, win: undefined }, true)
    state.ipc.emit(APP_OPEN_URL_READY, { ...event, senderFrame: {} }, true)
    state.ipc.emit(APP_OPEN_URL_READY, windowFixture(99).event, true)
    expect(state.send).not.toHaveBeenCalled()
    state.ipc.emit(APP_OPEN_URL_READY, event, true)
    expect(state.send).toHaveBeenCalledTimes(1)
    state.ipc.emit(APP_OPEN_URL_READY, event, false)
    open('https://example.com/later')
    expect(state.send).toHaveBeenCalledTimes(1)
  })
})
