import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { focusRunningInstanceWindow } from './singleInstance'

type FakeWin = {
  isDestroyed: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

function fakeWin(opts: { destroyed?: boolean; minimized?: boolean } = {}): FakeWin {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    restore: vi.fn(),
    focus: vi.fn(),
  }
}

const asWindows = (wins: FakeWin[]) => wins as unknown as BrowserWindow[]

describe('focusRunningInstanceWindow', () => {
  it('focuses the first live window', () => {
    const win = fakeWin()
    focusRunningInstanceWindow(asWindows([win]))
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('skips destroyed windows and focuses a live one', () => {
    const dead = fakeWin({ destroyed: true })
    const live = fakeWin()
    focusRunningInstanceWindow(asWindows([dead, live]))
    expect(dead.focus).not.toHaveBeenCalled()
    expect(live.focus).toHaveBeenCalledTimes(1)
  })

  it('restores a minimized window before focusing', () => {
    const win = fakeWin({ minimized: true })
    focusRunningInstanceWindow(asWindows([win]))
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('does not restore a window that is not minimized', () => {
    const win = fakeWin({ minimized: false })
    focusRunningInstanceWindow(asWindows([win]))
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there are no live windows', () => {
    const dead = fakeWin({ destroyed: true })
    expect(() => focusRunningInstanceWindow(asWindows([dead]))).not.toThrow()
    expect(dead.focus).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty list', () => {
    expect(() => focusRunningInstanceWindow(asWindows([]))).not.toThrow()
  })
})
