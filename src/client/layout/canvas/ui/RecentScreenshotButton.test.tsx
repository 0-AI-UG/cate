import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { notifyRuntimesChanged, setRuntimeResolver } from '@kernel/rpc/client'
import { installScreenshotPort, type RecentScreenshot, type ScreenshotPort } from '../screenshots'
import { readFileRefDrag } from '@workspace/files/contract'
import { RecentScreenshotButton } from './RecentScreenshotButton'

function fakePort(over: Partial<ScreenshotPort>): ScreenshotPort {
  return {
    recent: async () => [],
    onChanged: () => () => {},
    read: async () => '',
    drag: async () => {},
    addAnnotated: async () => { throw new Error('unused') },
    ...over,
  }
}

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'test', keyFingerprint: 'fp' }, features: ['screenCapture'] }))
})

afterEach(() => {
  installScreenshotPort(null)
  installClientIdentity(null)
})

it('retains a new capture over a stale initial read, and exports it repeatedly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let changed!: (value: RecentScreenshot[]) => void
  let resolveInitial!: (value: RecentScreenshot[]) => void
  const unsubscribe = vi.fn()
  const drag = vi.fn().mockResolvedValue(undefined)
  installScreenshotPort(fakePort({
    recent: () => new Promise(resolve => { resolveInitial = resolve }),
    onChanged: callback => { changed = callback; return unsubscribe },
    drag,
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton workspaceId="ws" />))
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
    vi.unstubAllGlobals()
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('renders nothing without a screenshot port or the screenCapture feature', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton workspaceId="ws" />))
    expect(host.childElementCount).toBe(0)
    installClientIdentity(createClientIdentity({ device: { name: 'test', keyFingerprint: 'fp' }, features: [] }))
    const shot = { id: 'shot', filePath: '/shot.png', dataUrl: 'data:image/png;base64,test' }
    await act(async () => installScreenshotPort(fakePort({ recent: async () => [shot] })))
    await act(async () => root.render(<RecentScreenshotButton workspaceId="other" />))
    expect(host.childElementCount).toBe(0)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('renders the annotation marker for a saved screenshot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installScreenshotPort(fakePort({
    recent: vi.fn().mockResolvedValue([{
      id: 'annotated', filePath: '/annotated.png', dataUrl: 'data:image/png;base64,test', annotated: true,
    }]),
  }))
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton workspaceId="ws" />))
    expect(host.querySelector('[aria-label="Annotated screenshot"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('opens clicked screenshots, navigates with overlay controls and keys, and closes the viewer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let nextImageWidth = 800
  let nextImageHeight = window.innerHeight - 160
  vi.stubGlobal('Image', class {
    src = ''
    naturalWidth = nextImageWidth
    naturalHeight = nextImageHeight
    decode = async () => {}
  })
  const shots = ['first', 'second', 'third'].map(id => ({ id, filePath: `/${id}.png`, dataUrl: `data:image/png;base64,${id}` }))
  const port = fakePort({
    recent: vi.fn().mockResolvedValue(shots),
    read: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw=='),
    drag: vi.fn().mockResolvedValue(undefined),
  })
  installScreenshotPort(port)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const dialog = () => document.querySelector('[role="dialog"]')!
  const key = (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
  const expectOriginal = (index: number) => {
    expect(port.read).toHaveBeenLastCalledWith(shots[index].id)
    expect(dialog().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
  }
  try {
    await act(async () => root.render(<RecentScreenshotButton workspaceId="ws" />))
    const thumbnail = host.querySelectorAll<HTMLButtonElement>('[draggable="true"]')[1]
    act(() => thumbnail.focus())
    await act(async () => thumbnail.click())
    expectOriginal(1)
    expect(dialog().contains(document.activeElement)).toBe(true)
    expect(dialog().querySelector('[aria-label="Annotate screenshot"]')).not.toBeNull()
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
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Draw with pen')
    expect(dialog().querySelector('img')?.className).toContain('rounded-xl')
    expect(dialog().querySelector('[aria-label="Annotate screenshot"]')).not.toBeNull()
    await act(async () => (dialog().querySelector('[aria-label="Add comment"]') as HTMLButtonElement).click())
    const annotation = dialog().querySelector('[aria-label="Annotate screenshot"]') as SVGSVGElement
    annotation.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) })
    await act(async () => annotation.dispatchEvent(new MouseEvent('click', { clientX: 400, clientY: 300, bubbles: true })))
    const comment = dialog().querySelector('[aria-label="Comment 1"]') as HTMLTextAreaElement
    expect(comment).not.toBeNull()
    const caretKey = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    await act(async () => comment.dispatchEvent(caretKey))
    expect(caretKey.defaultPrevented).toBe(false)
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
    expect(port.drag).toHaveBeenCalledWith('second')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('drags a workspace screenshot as a FileRef, not a native drag, while its workspace is open', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const open = new Set(['ws-a'])
  setRuntimeResolver((id) => (open.has(id) ? ({} as RuntimeProxy) : null))
  const drag = vi.fn().mockResolvedValue(undefined)
  const ref = { workspaceId: 'ws-a', path: '/data/screenshots/1-shot-annotated.png' }
  const shot: RecentScreenshot = { id: 'annotated:1', filePath: ref.path, ref, annotated: true, dataUrl: 'data:image/png;base64,test' }
  installScreenshotPort(fakePort({ recent: async () => [shot], drag }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RecentScreenshotButton workspaceId="ws-b" />))
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => { data.set(type, value) }, effectAllowed: 'all' }
    const event = Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), { dataTransfer })
    await act(async () => { host.querySelector('button')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(drag).not.toHaveBeenCalled()
    expect(readFileRefDrag({ getData: (type) => data.get(type) ?? '' })).toEqual({ refs: [ref] })
    // Its workspace closes: the copy cannot be read any more.
    act(() => { open.clear(); notifyRuntimesChanged() })
    expect(host.querySelector('button')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    setRuntimeResolver(null)
    vi.unstubAllGlobals()
  }
})
