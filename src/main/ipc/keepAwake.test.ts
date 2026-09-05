import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_AWAKE_GET, KEEP_AWAKE_SET, KEEP_AWAKE_CHANGED } from '../../shared/ipc-channels'
import { registerKeepAwakeHandlers } from './keepAwake'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  isStarted: vi.fn(),
  broadcast: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { on: mocks.on },
  ipcMain: { handle: mocks.handle },
  powerSaveBlocker: { start: mocks.start, stop: mocks.stop, isStarted: mocks.isStarted },
}))
vi.mock('../windowRegistry', () => ({ broadcastToAll: mocks.broadcast }))

function invoke(channel: string, value?: unknown) {
  return mocks.handle.mock.calls.find(([name]) => name === channel)![1]({}, value)
}

beforeEach(() => {
  vi.resetAllMocks()
  const active = new Set<number>()
  let nextId = 0
  mocks.start.mockImplementation(() => { active.add(nextId); return nextId++ })
  mocks.stop.mockImplementation((id: number) => active.delete(id))
  mocks.isStarted.mockImplementation((id: number) => active.has(id))
  registerKeepAwakeHandlers()
})

describe('keep awake', () => {
  it('starts disabled, shares one blocker, and broadcasts changes to all windows', () => {
    expect(invoke(KEEP_AWAKE_GET)).toBe(false)
    expect(invoke(KEEP_AWAKE_SET, true)).toBe(true)
    expect(invoke(KEEP_AWAKE_SET, true)).toBe(true)
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension')
    expect(invoke(KEEP_AWAKE_GET)).toBe(true)
    expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, true)

    expect(invoke(KEEP_AWAKE_SET, false)).toBe(false)
    expect(invoke(KEEP_AWAKE_SET, false)).toBe(false)
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(0)
    expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, false)
    expect(invoke(KEEP_AWAKE_SET, true)).toBe(true)
    expect(mocks.start).toHaveBeenCalledTimes(2)
  })

  it('releases the blocker when Cate quits', () => {
    invoke(KEEP_AWAKE_SET, true)
    mocks.on.mock.calls.find(([event]) => event === 'will-quit')![1]()
    expect(mocks.stop).toHaveBeenCalledWith(0)
    expect(invoke(KEEP_AWAKE_GET)).toBe(false)
  })

  it('rejects invalid input and leaves state off if the OS call fails', () => {
    expect(() => invoke(KEEP_AWAKE_SET, 'true')).toThrow('Expected a boolean')
    expect(mocks.start).not.toHaveBeenCalled()
    mocks.start.mockImplementation(() => { throw new Error('unavailable') })
    expect(() => invoke(KEEP_AWAKE_SET, true)).toThrow('unavailable')
    expect(invoke(KEEP_AWAKE_GET)).toBe(false)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
