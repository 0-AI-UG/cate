// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_REFS_MIME } from '@workspace/files/contract'
import { droppedRefImages, useFileDragActive } from './fileDrop'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('chat ref drops', () => {
  it('reads dropped workspace images through their runtimes and skips other files', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const png = { workspaceId: 'ws-a', path: '/data/screenshots/1-shot.PNG' }
    const images = await droppedRefImages([png, { workspaceId: 'ws-b', path: '/repo/notes.md' }, { workspaceId: 'ws-b', path: '/repo/jpg' }], readBytes)
    expect(images).toEqual([{ name: '1-shot.PNG', type: 'image/png', dataUrl: 'data:image/png;base64,AQID' }])
    expect(readBytes).toHaveBeenCalledExactlyOnceWith(png)
  })

  it('drops an image that cannot be read', async () => {
    const images = await droppedRefImages([{ workspaceId: 'ws', path: '/a.jpg' }], async () => { throw new Error('gone') })
    expect(images).toEqual([])
  })

  it('shows the drop overlay for FileRef drags as for OS files', async () => {
    let active = false
    function Probe() {
      active = useFileDragActive()
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(<Probe />))
    const drag = (type: string, types: string[]) => Object.assign(new Event(type, { bubbles: true }), { dataTransfer: { types } })
    act(() => { document.dispatchEvent(drag('dragenter', ['text/plain'])) })
    expect(active).toBe(false)
    act(() => { document.dispatchEvent(drag('dragenter', [FILE_REFS_MIME, 'text/uri-list'])) })
    expect(active).toBe(true)
    act(() => { document.dispatchEvent(drag('dragleave', [FILE_REFS_MIME, 'text/uri-list'])) })
    expect(active).toBe(false)
    act(() => root.unmount())
  })

  it('shows the overlay for OS files', async () => {
    let active = false
    function Probe() {
      active = useFileDragActive()
      return null
    }
    const drag = (type: string) => Object.assign(new Event(type, { bubbles: true }), { dataTransfer: { types: ['Files'] } })
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    act(() => { document.dispatchEvent(drag('dragenter')) })
    expect(active).toBe(true)
    act(() => { document.dispatchEvent(drag('dragleave')) })
    act(() => root.unmount())
  })
})
