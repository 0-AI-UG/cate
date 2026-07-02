// =============================================================================
// ExtensionPanel — resolves its proxy URL for the OWNING workspace. Regression:
// the panel used to read workspaceId from window.location.search, which is empty
// in the main window, so every reverse-API call (and the server's CATE_API
// session) resolved no workspace — storage returned `no-storage`, openFile /
// createPanel targeted nothing, and the page reported "no workspace selected".
// The workspaceId MUST come from the panel prop renderPanelComponent supplies.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/portalRegistry', () => ({ portalRegistry: { register: vi.fn(), unregister: vi.fn() } }))

import ExtensionPanel, { readDroppedFiles, clampText, guestScrollbarCss } from './ExtensionPanel'

const proxyUrl = vi.fn(async (_args: { extensionId: string; workspaceId: string; panelId: string }) => ({
  url: 'http://127.0.0.1:9/ext/tok/?x',
  preloadPath: '/p/cateHost.js',
}))
const panelClosed = vi.fn()

let container: HTMLDivElement
let root: Root

function mount(props: { workspaceId: string }): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    extensionProxyUrl: proxyUrl,
    extensionPanelClosed: panelClosed,
    extensionServerRestart: vi.fn(async () => undefined),
    // The panel ensures the extension registry is loaded (for the files.drop scope).
    extensionList: vi.fn(async () => []),
    onExtensionsChanged: vi.fn(),
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ExtensionPanel
        panelId="panel-1"
        workspaceId={props.workspaceId}
        extensionId="cate.kitchensink"
        extensionPanelId="main"
      />,
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Simulate the real main window: a query string that does NOT carry workspaceId.
  window.history.replaceState({}, '', '/index.html?window=main')
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('ExtensionPanel', () => {
  it('resolves the proxy URL with the prop workspaceId, not the (empty) URL param', async () => {
    mount({ workspaceId: 'ws-real-123' })
    // Let the resolve effect's promise settle.
    await act(async () => { await Promise.resolve() })

    expect(proxyUrl).toHaveBeenCalledTimes(1)
    expect(proxyUrl).toHaveBeenCalledWith({
      extensionId: 'cate.kitchensink',
      workspaceId: 'ws-real-123',
      panelId: 'panel-1',
    })
    // Guard the exact regression: never the empty string the URL param would give.
    expect(proxyUrl.mock.calls[0][0].workspaceId).not.toBe('')
  })

  it('reports the panel closed for the same workspace on unmount', async () => {
    mount({ workspaceId: 'ws-real-123' })
    await act(async () => { await Promise.resolve() })
    act(() => { root.unmount() })
    expect(panelClosed).toHaveBeenCalledWith({
      extensionId: 'cate.kitchensink',
      workspaceId: 'ws-real-123',
      panelId: 'panel-1',
    })
    // Re-mount a throwaway so afterEach's unmount has a live root.
    mount({ workspaceId: 'ws-real-123' })
  })

  it('injects the app scrollbar CSS into the guest at dom-ready', async () => {
    mount({ workspaceId: 'ws-real-123' })
    await act(async () => { await Promise.resolve() })

    const webview = container.querySelector('webview') as HTMLElement & { insertCSS?: unknown }
    expect(webview).toBeTruthy()
    const insertCSS = vi.fn(async () => 'css-key')
    webview.insertCSS = insertCSS
    act(() => { webview.dispatchEvent(new Event('dom-ready')) })

    expect(insertCSS).toHaveBeenCalledTimes(1)
    expect(insertCSS.mock.calls[0][0]).toContain('::-webkit-scrollbar')
  })
})

describe('guestScrollbarCss', () => {
  it('bakes the host theme thumb colors into the injected rules', () => {
    document.documentElement.style.setProperty('--scrollbar-thumb', 'rgba(1,2,3,0.5)')
    document.documentElement.style.setProperty('--scrollbar-thumb-hover', 'rgba(4,5,6,0.7)')
    const css = guestScrollbarCss()
    expect(css).toContain('::-webkit-scrollbar-thumb{background:rgba(1,2,3,0.5);border-radius:3px}')
    expect(css).toContain(':hover{background:rgba(4,5,6,0.7)}')
    document.documentElement.style.removeProperty('--scrollbar-thumb')
    document.documentElement.style.removeProperty('--scrollbar-thumb-hover')
  })

  it('falls back to the dark defaults when the vars are unset', () => {
    const css = guestScrollbarCss()
    expect(css).toContain('rgba(255,255,255,0.15)')
    expect(css).toContain('rgba(255,255,255,0.25)')
  })
})

// A minimal DataTransfer stand-in: jsdom doesn't construct one with files.
function fakeDataTransfer(opts: { files?: File[]; data?: Record<string, string> }): DataTransfer {
  const data = opts.data ?? {}
  return {
    files: opts.files ?? [],
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer
}

describe('clampText — byte-aware drop cap', () => {
  const MAX_DROP_BYTES = 32 * 1024 * 1024

  it('leaves an ASCII string under the byte budget untouched', () => {
    const out = clampText('hello')
    expect(out.truncated).toBe(false)
    expect(out.text).toBe('hello')
  })

  it('clamps multi-byte (3-byte) text to the BYTE budget, not the code-unit length', () => {
    // 'あ' is one UTF-16 code unit but 3 UTF-8 bytes. Pick a length whose
    // code-unit count stays under the cap while the UTF-8 size exceeds it — the
    // old text.length check let this whole ~36MB payload through.
    const charCount = Math.ceil(MAX_DROP_BYTES / 2) // ~16.7M chars < cap (code units)
    const text = 'あ'.repeat(charCount)
    expect(text.length).toBeLessThan(MAX_DROP_BYTES) // UTF-16 length passes old check
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(MAX_DROP_BYTES)

    const out = clampText(text)
    expect(out.truncated).toBe(true)
    const outBytes = new TextEncoder().encode(out.text).length
    expect(outBytes).toBeLessThanOrEqual(MAX_DROP_BYTES)
    // Cut on a char boundary: no replacement char / split sequence at the end.
    expect(out.text.endsWith('あ')).toBe(true)
  })
})

describe('readDroppedFiles', () => {
  it('reads OS File drops in-renderer (no IPC, resolves path via getPathForFile)', async () => {
    const fsReadFile = vi.fn()
    const getPathForFile = vi.fn(() => '/Users/me/.claude/projects/x/sess.jsonl')
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { fsReadFile, getPathForFile }

    const file = new File(['{"type":"session"}\n'], 'sess.jsonl', { type: 'application/json' })
    const out = await readDroppedFiles(fakeDataTransfer({ files: [file] }), 'ws-1')

    expect(out).toEqual([
      {
        name: 'sess.jsonl',
        path: '/Users/me/.claude/projects/x/sess.jsonl',
        text: '{"type":"session"}\n',
        size: file.size,
        truncated: false,
      },
    ])
    // OS files are read client-side; fsReadFile must NOT be called.
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('reads Cate file-explorer paths over IPC (application/cate-files)', async () => {
    const fsReadFile = vi.fn(async (p: string) => `content-of:${p}`)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { fsReadFile, getPathForFile: vi.fn() }

    const dt = fakeDataTransfer({
      data: { 'application/cate-files': JSON.stringify(['/ws/.cate/a.jsonl', '/ws/.cate/b.jsonl']) },
    })
    const out = await readDroppedFiles(dt, 'ws-7')

    expect(fsReadFile).toHaveBeenCalledWith('/ws/.cate/a.jsonl', 'ws-7')
    expect(out.map((f) => f.name)).toEqual(['a.jsonl', 'b.jsonl'])
    expect(out[0].text).toBe('content-of:/ws/.cate/a.jsonl')
  })

  it('falls back to the single application/cate-file path', async () => {
    const fsReadFile = vi.fn(async () => 'x')
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { fsReadFile, getPathForFile: vi.fn() }
    const dt = fakeDataTransfer({ data: { 'application/cate-file': '/ws/only.jsonl' } })
    const out = await readDroppedFiles(dt, 'ws-1')
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/ws/only.jsonl')
  })

  it('skips files whose IPC read is denied (outside the workspace)', async () => {
    const fsReadFile = vi.fn(async () => { throw new Error('Access denied') })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { fsReadFile, getPathForFile: vi.fn() }
    const dt = fakeDataTransfer({ data: { 'application/cate-file': '/etc/passwd' } })
    const out = await readDroppedFiles(dt, 'ws-1')
    expect(out).toEqual([])
  })
})
