import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { RecentScreenshotButton } from './RecentScreenshotButton'

it('retains a new capture over a stale initial read, and exports it repeatedly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let changed!: (value: RecentScreenshot[]) => void
  let resolveInitial!: (value: RecentScreenshot[]) => void
  const unsubscribe = vi.fn()
  const drag = vi.fn().mockResolvedValue(undefined)
  const originalAPI = window.electronAPI
  window.electronAPI = {
    ...originalAPI,
    getRecentScreenshot: () => new Promise(resolve => { resolveInitial = resolve }),
    onRecentScreenshotChanged: callback => { changed = callback; return unsubscribe },
    dragRecentScreenshot: drag,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton />))
    expect(host.querySelector('button')).toBeNull()
    const shot = { id: 'shot', filePath: '/desktop/shot.png', dataUrl: 'data:image/png;base64,test' }
    await act(async () => { changed([shot]); resolveInitial([]) })
    const button = host.querySelector('button')!
    expect(button).not.toBeNull()
    for (let i = 0; i < 2; i++) {
      await act(async () => { button.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })) })
    }
    expect(drag).toHaveBeenCalledTimes(2)
    expect(drag).toHaveBeenLastCalledWith('shot')
    expect(host.querySelector('img')?.getAttribute('src')).toBe(shot.dataUrl)
    const older = { ...shot, id: 'older', filePath: '/desktop/older.png' }
    await act(async () => changed([shot, older]))
    expect(host.querySelectorAll('img')).toHaveLength(2)
    const stack = host.firstElementChild as HTMLElement
    expect(stack.style.height).toBe('40px')
    act(() => stack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(stack.style.height).toBe('92px')
    const dragButtons = host.querySelectorAll('[draggable="true"]')
    await act(async () => dragButtons[1].dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })))
    expect(drag).toHaveBeenLastCalledWith('older')
    act(() => (host.querySelector('[aria-label="Dismiss screenshot preview"]') as HTMLButtonElement).click())
    expect(host.querySelectorAll('img')).toHaveLength(1)
    await act(async () => changed([shot, older]))
    expect(host.querySelectorAll('img')).toHaveLength(1)
    act(() => changed([]))
    expect(host.querySelector('button')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    window.electronAPI = originalAPI
    vi.unstubAllGlobals()
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('does not crash the canvas when an older preload lacks screenshot APIs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalAPI = window.electronAPI
  window.electronAPI = {} as typeof window.electronAPI
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton />))
    expect(host.childElementCount).toBe(0)
  } finally {
    act(() => root.unmount())
    window.electronAPI = originalAPI
    vi.unstubAllGlobals()
  }
})
