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

it('opens clicked screenshots, navigates with overlay controls and keys, and closes the viewer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalAPI = window.electronAPI
  let nextImageWidth = 800
  let nextImageHeight = window.innerHeight - 160
  vi.stubGlobal('Image', class {
    src = ''
    naturalWidth = nextImageWidth
    naturalHeight = nextImageHeight
    decode = async () => {}
  })
  const originalBytes = new Uint8Array([137, 80, 78, 71]).buffer
  const shots = ['first', 'second', 'third'].map(id => ({ id, filePath: `/${id}.png`, dataUrl: `data:image/png;base64,${id}` }))
  window.electronAPI = {
    ...originalAPI,
    getRecentScreenshot: vi.fn().mockResolvedValue(shots),
    fsReadBinary: vi.fn().mockResolvedValue(originalBytes),
    shellOpenPath: vi.fn().mockResolvedValue({ ok: true }),
    onRecentScreenshotChanged: vi.fn(() => () => {}),
    dragRecentScreenshot: vi.fn().mockResolvedValue(undefined),
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const dialog = () => document.querySelector('[role="dialog"]')!
  const key = (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
  const expectOriginal = (index: number) => {
    expect(window.electronAPI.fsReadBinary).toHaveBeenLastCalledWith(shots[index].filePath)
    expect(dialog().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
  }
  try {
    await act(async () => root.render(<RecentScreenshotButton />))
    const thumbnail = host.querySelectorAll<HTMLButtonElement>('[draggable="true"]')[1]
    act(() => thumbnail.focus())
    await act(async () => thumbnail.click())
    expectOriginal(1)
    expect(dialog().contains(document.activeElement)).toBe(true)
    nextImageWidth = 4000
    nextImageHeight = 100
    await key('ArrowRight')
    expectOriginal(2)
    expect(parseFloat((dialog().querySelector('img') as HTMLImageElement).style.height)).toBeCloseTo((window.innerWidth - 96) / 40)
    expect((dialog().querySelector('img') as HTMLImageElement).style.width).toBe(`${window.innerWidth - 96}px`)
    nextImageWidth = 800
    nextImageHeight = window.innerHeight - 160
    await key('ArrowRight')
    expectOriginal(0)
    await key('ArrowLeft')
    expectOriginal(2)
    await key('ArrowLeft')
    expectOriginal(1)
    await act(async () => (dialog().querySelector('[aria-label="Next screenshot"]') as HTMLButtonElement).click())
    expectOriginal(2)
    await act(async () => (dialog().querySelector('[aria-label="Previous screenshot"]') as HTMLButtonElement).click())
    expectOriginal(1)
    await key('Tab')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit screenshot')
    expect(dialog().querySelector('img')?.className).toContain('rounded-xl')
    await act(async () => (dialog().querySelector('[aria-label="Edit screenshot"]') as HTMLButtonElement).click())
    expect(window.electronAPI.shellOpenPath).not.toHaveBeenCalled()
    expect(dialog().querySelector('[aria-label="Draw on screenshot"]')).not.toBeNull()
    await act(async () => (dialog().querySelector('[aria-label="Edit screenshot"]') as HTMLButtonElement).click())
    expect(dialog().querySelector('[aria-label="Download screenshot"]')?.getAttribute('href')).toBe('data:image/png;base64,iVBORw==')
    expect(dialog().querySelector('[aria-label="Download screenshot"]')?.getAttribute('download')).toBe('second.png')
    await act(async () => (dialog().querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click())
    expect(dialog().querySelector('[aria-label="Fit screenshot"]')?.textContent).toBe('120%')
    await act(async () => (dialog().querySelector('[aria-label="Fit screenshot"]') as HTMLButtonElement).click())
    expect(dialog().querySelector('[aria-label="Fit screenshot"]')?.textContent).toBe('100%')
    await key('Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(thumbnail)
    await act(async () => thumbnail.click())
    await act(async () => (dialog().querySelector('[aria-label="Close screenshot preview"]') as HTMLButtonElement).click())
    expect(dialog()).toBeNull()
    await act(async () => thumbnail.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })))
    await act(async () => thumbnail.click())
    expect(dialog()).toBeNull()
    expect(window.electronAPI.dragRecentScreenshot).toHaveBeenCalledWith('second')
  } finally {
    act(() => root.unmount())
    host.remove()
    window.electronAPI = originalAPI
    vi.unstubAllGlobals()
  }
})
