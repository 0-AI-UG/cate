import { describe, expect, it, vi } from 'vitest'
import type { RecentScreenshot as ShellScreenshot } from '../contract'
import { createScreenshotPort } from './screenshots'
import { createFakeDesktop } from './testing'

const readBytes = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2])))
vi.mock('@workspace/files/client', () => ({ fileRefs: { readBytes } }))

describe('desktop screenshot port', () => {
  it('hands an annotated screenshot to main and lists it from the shared stack', async () => {
    const { api } = createFakeDesktop({ features: ['screenCapture'] })
    let broadcast!: (shots: ShellScreenshot[]) => void
    vi.spyOn(api.capture, 'onRecentScreenshots').mockImplementation((listener) => { broadcast = listener; return () => {} })
    const add = vi.spyOn(api.capture, 'addAnnotatedScreenshot')
    const dragRecentScreenshot = vi.spyOn(api.capture, 'dragRecentScreenshot')
    const port = createScreenshotPort(api)
    const changed = vi.fn()
    port.onChanged(changed)
    const ref = { workspaceId: 'ws-a', path: '/data/screenshots/1-shot-annotated.png' }
    const shot = await port.addAnnotated(ref, 'data:image/png;base64,AA==')
    expect(add).toHaveBeenCalledWith(ref, new Uint8Array([0]))
    expect(shot).toMatchObject({ ref, filePath: ref.path, annotated: true, dataUrl: 'data:image/png;base64,' })

    // Main sends the list (with the shot) to every window.
    broadcast([{ id: shot.id, thumbnail: 'thumb', ref }, { id: '/desktop/a.png:1', thumbnail: 'os' }])
    expect(changed).toHaveBeenLastCalledWith([
      { id: shot.id, filePath: ref.path, ref, annotated: true, dataUrl: 'thumb' },
      { id: '/desktop/a.png:1', filePath: '/desktop/a.png', dataUrl: 'os' },
    ])
    // The full image is read through the workspace, never kept in the stack.
    expect(await port.read(shot.id)).toBe(`data:image/png;base64,${btoa('\x01\x02')}`)
    expect(readBytes).toHaveBeenCalledWith(ref)
    await port.drag(shot.id)
    expect(dragRecentScreenshot).not.toHaveBeenCalled()
  })
})
