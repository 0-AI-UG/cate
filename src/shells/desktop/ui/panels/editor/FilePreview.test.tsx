import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => null) })
})

const m = vi.hoisted(() => ({
  getDocument: vi.fn(),
  readBinary: vi.fn(),
  watch: vi.fn((..._args: unknown[]) => () => {}),
}))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: m.getDocument }))
vi.mock('@workspace/files/client', () => ({
  fsClient: (workspaceId: string) => ({ readBinary: (path: string) => m.readBinary(path, workspaceId) }),
  watchFsRoot: m.watch,
}))

import FilePreview from './FilePreview'

let host: HTMLDivElement
let root: Root

const flush = () => act(async () => { await Promise.resolve() })
const show = (filePath: string) => act(async () => root.render(<FilePreview workspaceId="ws-1" filePath={filePath} />))

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('FilePreview', () => {
  it('fetches the bytes from its workspace and trusts magic bytes over the extension', async () => {
    m.readBinary.mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
    await show('/workspace/photo.pdf')
    await flush()
    expect(m.readBinary).toHaveBeenCalledWith('/workspace/photo.pdf', 'ws-1')
    const image = host.querySelector('img')
    expect(image?.alt).toBe('photo.pdf')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
    expect(m.getDocument).not.toHaveBeenCalled()
  })

  it('fetches again after the file changes on disk', async () => {
    m.readBinary
      .mockResolvedValueOnce(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
      .mockResolvedValueOnce(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01]))
    await show('/workspace/photo.png')
    await flush()
    expect(m.watch).toHaveBeenCalledWith('ws-1', '/workspace', expect.any(Function))
    const onChange = m.watch.mock.calls.at(-1)![2] as (change: { type: string; path: string }) => void
    await act(async () => {
      onChange({ type: 'update', path: '/workspace/other.png' })
      onChange({ type: 'update', path: '/workspace/photo.png' })
    })
    await flush()
    expect(m.readBinary).toHaveBeenCalledTimes(2)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORwE=')
  })

  it('shows a failed read', async () => {
    m.readBinary.mockRejectedValue(new Error('Remote unavailable'))
    await show('/workspace/missing.pdf')
    await flush()
    expect(host.textContent).toContain('Remote unavailable')
  })

  it('ignores an obsolete read when the file changes before it resolves', async () => {
    let resolveFirst!: (value: Uint8Array) => void
    m.readBinary
      .mockReturnValueOnce(new Promise<Uint8Array>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))
    await show('/workspace/first.png')
    await show('/workspace/second.jpg')
    await flush()
    expect(host.querySelector('img')?.alt).toBe('second.jpg')
    await act(async () => resolveFirst(Uint8Array.from([0x25, 0x50, 0x44, 0x46])))
    expect(host.querySelector('img')?.alt).toBe('second.jpg')
    expect(m.getDocument).not.toHaveBeenCalled()
  })

  it('destroys an in-flight PDF load on unmount', async () => {
    const destroy = vi.fn(async () => undefined)
    m.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy })
    m.readBinary.mockResolvedValue(Uint8Array.from([0x25, 0x50, 0x44, 0x46]))
    await show('/workspace/report.pdf')
    await flush()
    expect(m.getDocument).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    expect(destroy).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
