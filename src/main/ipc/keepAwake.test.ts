import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_AWAKE_TOGGLE, KEEP_AWAKE_GET, KEEP_AWAKE_SET, KEEP_AWAKE_CHANGED } from '../../shared/ipc-channels'
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
  it('starts disabled, shares one display-sleep blocker, and broadcasts changes to all windows', () => {
    expect(invoke(KEEP_AWAKE_GET)).toEqual({ enabled: false, endsAt: null })
    expect(invoke(KEEP_AWAKE_SET, null)).toEqual({ enabled: true, endsAt: null })
    expect(invoke(KEEP_AWAKE_SET, null)).toEqual({ enabled: true, endsAt: null })
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep')
    expect(invoke(KEEP_AWAKE_GET)).toEqual({ enabled: true, endsAt: null })
    expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, { enabled: true, endsAt: null })

    expect(invoke(KEEP_AWAKE_SET, false)).toEqual({ enabled: false, endsAt: null })
    expect(invoke(KEEP_AWAKE_SET, false)).toEqual({ enabled: false, endsAt: null })
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(0)
    expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, { enabled: false, endsAt: null })
    expect(invoke(KEEP_AWAKE_SET, null)).toEqual({ enabled: true, endsAt: null })
    expect(mocks.start).toHaveBeenCalledTimes(2)
  })

  it('releases the blocker when Cate quits', () => {
    invoke(KEEP_AWAKE_SET, null)
    mocks.on.mock.calls.find(([event]) => event === 'will-quit')![1]()
    expect(mocks.stop).toHaveBeenCalledWith(0)
    expect(invoke(KEEP_AWAKE_GET)).toEqual({ enabled: false, endsAt: null })
  })

  it('rejects invalid input and leaves state off if the OS call fails', () => {
    expect(() => invoke(KEEP_AWAKE_SET, 'true')).toThrow('Expected a keep-awake duration')
    expect(mocks.start).not.toHaveBeenCalled()
    mocks.start.mockImplementation(() => { throw new Error('unavailable') })
    expect(() => invoke(KEEP_AWAKE_SET, null)).toThrow('unavailable')
    expect(invoke(KEEP_AWAKE_GET)).toEqual({ enabled: false, endsAt: null })
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})

it('toggles the shared state atomically and broadcasts both transitions', () => {
  expect(invoke(KEEP_AWAKE_TOGGLE)).toEqual({ enabled: true, endsAt: null })
  expect(invoke(KEEP_AWAKE_TOGGLE)).toEqual({ enabled: false, endsAt: null })
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.stop).toHaveBeenCalledTimes(1)
  expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, { enabled: false, endsAt: null })
})

it('expires a duration and replaces the old timer when a new duration is selected', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const first = invoke(KEEP_AWAKE_SET, 30)
    expect(first).toEqual({ enabled: true, endsAt: Date.now() + 30 * 60_000 })
    vi.advanceTimersByTime(10 * 60_000)
    expect(invoke(KEEP_AWAKE_SET, 60)).toEqual({ enabled: true, endsAt: Date.now() + 60 * 60_000 })
    vi.advanceTimersByTime(30 * 60_000)
    expect(invoke(KEEP_AWAKE_GET)).toMatchObject({ enabled: true })
    vi.advanceTimersByTime(30 * 60_000)
    expect(invoke(KEEP_AWAKE_GET)).toEqual({ enabled: false, endsAt: null })
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(0)
    expect(mocks.broadcast).toHaveBeenLastCalledWith(KEEP_AWAKE_CHANGED, { enabled: false, endsAt: null })
  } finally {
    vi.useRealTimers()
  }
})
