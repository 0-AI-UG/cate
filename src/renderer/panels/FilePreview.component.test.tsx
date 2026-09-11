import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: pdfMocks.getDocument,
}))

import FilePreview from './FilePreview'
import { useAppStore } from '../stores/appStore'
import type { PanelState, WorkspaceState } from '../../shared/types'

const initialAppState = useAppStore.getState()

let host: HTMLDivElement
let root: Root
let fsReadBinary: ReturnType<typeof vi.fn>
let shellShowInFolder: ReturnType<typeof vi.fn>

function workspace(filePath?: string, _documentType?: 'pdf' | 'docx' | 'image'): WorkspaceState {
  return {
    id: 'ws-1',
    name: 'Workspace',
    color: '#000',
    rootPath: '/workspace',
    panels: {
      'document-1': {
        id: 'document-1',
        type: 'editor',
        title: 'Document',
        filePath,
      } as PanelState,
    },
  }
}

function PreviewHarness() {
  const filePath = useAppStore(s => s.workspaces[0].panels['document-1'].filePath)
  return <FilePreview filePath={filePath ?? ''} workspaceId="ws-1" />
}

function mount(): void {
  act(() => {
    root.render(<PreviewHarness />)
  })
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fsReadBinary = vi.fn()
  shellShowInFolder = vi.fn()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    fsReadBinary,
    shellShowInFolder,
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialAppState, true)
})

describe('FilePreview component', () => {
  it('loads binary data for the owning workspace and trusts magic bytes over stale persisted type', async () => {
    useAppStore.setState({ workspaces: [workspace('/workspace/photo.png', 'pdf')], selectedWorkspaceId: 'ws-1' })
    fsReadBinary.mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer)

    mount()
    expect(host.textContent).toContain('Loading photo.png…')
    await flush()

    expect(fsReadBinary).toHaveBeenCalledWith('/workspace/photo.png', 'ws-1')
    const image = host.querySelector('img')
    expect(image?.alt).toBe('photo.png')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==')
    expect(pdfMocks.getDocument).not.toHaveBeenCalled()
  })

  it('offers Finder recovery for a failed local file and forwards the workspace id', async () => {
    useAppStore.setState({ workspaces: [workspace('/workspace/missing.pdf', 'pdf')], selectedWorkspaceId: 'ws-1' })
    fsReadBinary.mockRejectedValue(new Error('Permission denied'))

    mount()
    await flush()

    expect(host.textContent).toContain('Permission denied')
    const button = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Show in Finder')
    expect(button).toBeTruthy()
    act(() => button!.click())
    expect(shellShowInFolder).toHaveBeenCalledWith('/workspace/missing.pdf', 'ws-1')
  })

  it('does not offer a local Finder action for a remote document', async () => {
    useAppStore.setState({
      workspaces: [workspace('cate-runtime://srv_1/home/me/missing.pdf', 'pdf')],
      selectedWorkspaceId: 'ws-1',
    })
    fsReadBinary.mockRejectedValue(new Error('Remote unavailable'))

    mount()
    await flush()

    expect(host.textContent).toContain('Remote unavailable')
    expect(host.textContent).not.toContain('Show in Finder')
  })

  it('ignores an obsolete read when the panel file changes before it resolves', async () => {
    let resolveFirst!: (value: ArrayBuffer) => void
    const first = new Promise<ArrayBuffer>((resolve) => { resolveFirst = resolve })
    fsReadBinary
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer)
    useAppStore.setState({ workspaces: [workspace('/workspace/first.png', 'image')], selectedWorkspaceId: 'ws-1' })
    mount()

    act(() => {
      useAppStore.setState({ workspaces: [workspace('/workspace/second.jpg', 'image')] })
    })
    await flush()
    expect(host.querySelector('img')?.alt).toBe('second.jpg')

    await act(async () => {
      resolveFirst(Uint8Array.from([0x25, 0x50, 0x44, 0x46]).buffer)
      await first
    })
    expect(host.querySelector('img')?.alt).toBe('second.jpg')
    expect(pdfMocks.getDocument).not.toHaveBeenCalled()
  })

  it('destroys an in-flight PDF loading task on unmount', async () => {
    const destroy = vi.fn(async () => undefined)
    pdfMocks.getDocument.mockReturnValue({
      promise: new Promise(() => {}),
      destroy,
    })
    useAppStore.setState({ workspaces: [workspace('/workspace/report.pdf', 'pdf')], selectedWorkspaceId: 'ws-1' })
    fsReadBinary.mockResolvedValue(Uint8Array.from([0x25, 0x50, 0x44, 0x46]).buffer)

    mount()
    await flush()
    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    expect(destroy).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
