import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ getDocument: vi.fn(), render: vi.fn(), destroy: vi.fn(async () => {}), cancel: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: m.getDocument, RenderingCancelledException: class extends Error {} }))
import PdfViewer from './PdfViewer'

it('releases offscreen backing stores and renders them again on return', async () => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const observers = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(el: Element) { observers.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('devicePixelRatio', 2)
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn() } as never)
  m.render.mockReturnValue({ promise: Promise.resolve(), cancel: m.cancel })
  const pdf = { numPages: 2, getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }), render: m.render }) }
  m.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: m.destroy })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<PdfViewer data={new Uint8Array([1])} />))
    const canvas = host.querySelector('canvas')!
    expect(canvas.width).toBe(0)
    expect(m.render).not.toHaveBeenCalled()
    const update = observers.get(canvas.parentElement!)!
    await act(async () => update([{ isIntersecting: true }]))
    expect(canvas.width).toBe(300)
    expect(canvas.height).toBe(600)
    await act(async () => update([{ isIntersecting: false }]))
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(m.cancel).toHaveBeenCalledTimes(1)
    await act(async () => update([{ isIntersecting: true }]))
    expect(canvas.width).toBe(300)
    expect(m.render).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    expect(m.destroy).toHaveBeenCalledTimes(1)
    context.mockRestore()
    vi.unstubAllGlobals()
  }
})
