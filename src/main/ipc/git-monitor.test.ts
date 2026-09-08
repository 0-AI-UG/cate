import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>(), poll: vi.fn() }))
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { on: (key: string, handler: (...args: any[]) => void) => mocks.handlers.set(key, handler) } }))
vi.mock('../logger', () => ({ default: { debug: vi.fn(), warn: vi.fn() } }))
vi.mock('../windowRegistry', () => ({ isAnyWindowFocused: () => true, windowFromEvent: () => ({ id: 1 }), sendToWindow: vi.fn() }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: () => ({ vcs: { monitorStatus: mocks.poll }, file: { watch: () => vi.fn() } }) } }))
import { registerHandlers, stopMonitorsForWindow } from './git-monitor'
import { GIT_MONITOR_START, GIT_MONITOR_STOP } from '../../shared/ipc-channels'
afterEach(() => { stopMonitorsForWindow(1); vi.useRealTimers() })
it('does not resurrect a stopped monitor when its in-flight poll completes', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  mocks.poll.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  registerHandlers()
  mocks.handlers.get(GIT_MONITOR_START)!({}, 'workspace', '/tmp/project')
  expect(mocks.poll).toHaveBeenCalledTimes(1)
  mocks.handlers.get(GIT_MONITOR_STOP)!({}, 'workspace')
  finish({ branch: 'main', dirty: false, branches: ['main'] })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(mocks.poll).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
