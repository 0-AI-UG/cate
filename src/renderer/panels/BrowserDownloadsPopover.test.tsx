import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPanelDownload } from './BrowserDownloadsPopover'
import { BrowserDownloadsPopover } from './BrowserDownloadsPopover'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const progressing: BrowserPanelDownload = {
  id: 'download-1',
  webContentsId: 42,
  tabId: 'tab-1',
  url: 'https://example.com/archive.zip',
  filename: 'archive.zip',
  filePath: '/tmp/archive.zip',
  state: 'progressing',
  receivedBytes: 512,
  totalBytes: 1024,
  at: 1,
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BrowserDownloadsPopover', () => {
  it('shows download progress and allows cancellation', () => {
    const onAction = vi.fn()
    act(() => root.render(
      <BrowserDownloadsPopover
        downloads={[progressing]}
        onAction={onAction}
        onClose={vi.fn()}
        triggerRef={{ current: null }}
      />,
    ))

    expect(host.textContent).toContain('archive.zip')
    expect(host.textContent).toContain('512 B of 1.0 KB')
    expect(host.querySelector<HTMLElement>('.bg-agent')?.style.width).toBe('50%')

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Cancel archive.zip"]')?.click())
    expect(onAction).toHaveBeenCalledWith(progressing, 'cancel')
  })

  it('opens completed downloads and reveals them in their folder', () => {
    const onAction = vi.fn()
    const completed = { ...progressing, state: 'completed' as const, receivedBytes: 1024 }
    act(() => root.render(
      <BrowserDownloadsPopover
        downloads={[completed]}
        onAction={onAction}
        onClose={vi.fn()}
        triggerRef={{ current: null }}
      />,
    ))

    const fileButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('archive.zip'))
    act(() => fileButton?.click())
    expect(onAction).toHaveBeenCalledWith(completed, 'open')

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Show archive.zip in folder"]')?.click())
    expect(onAction).toHaveBeenCalledWith(completed, 'show')
  })
})
