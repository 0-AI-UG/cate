// =============================================================================
// useCateHostActionResponder — renderer half of the extension reverse API,
// rendered. Main forwards a guest's state-mutating cate.* call here; this hook
// executes it against the app store and replies. We drive each Kitchen Sink
// action (editor.openFile, canvas.createPanel, panel.setTitle) through the
// captured CATE_HOST_ACTION callback and assert it reuses the SAME panel-open
// path the file explorer uses — including resolving an extension's relative
// path to an absolute one (the "blank panel" regression).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/Users/dev/repo'
const WS = 'ws-1'

const h = vi.hoisted(() => ({
  openFileAsPanel: vi.fn(() => 'new-editor-id'),
  revealPanel: vi.fn(async () => {}),
  createExtensionPanel: vi.fn(() => 'new-ext-id'),
  updatePanelTitle: vi.fn(),
  editorCreate: vi.fn(() => 'reg-editor-id'),
  placementForActivePanel: vi.fn(),
  setPendingReveal: vi.fn(),
}))

vi.mock('../lib/fs/fileRouting', () => ({ openFileAsPanel: h.openFileAsPanel }))
vi.mock('../lib/workspace/panelReveal', () => ({ revealPanel: h.revealPanel }))
vi.mock('../lib/workspace/canvasAccess', () => ({ placementForActivePanel: h.placementForActivePanel }))
vi.mock('../lib/editor/editorReveal', () => ({ setPendingReveal: h.setPendingReveal }))
vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../panels/registry', () => ({
  PANEL_REGISTRY: {
    editor: { create: h.editorCreate },
    extension: { create: vi.fn() },
  },
}))
vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [{ id: WS, rootPath: ROOT }],
      createExtensionPanel: h.createExtensionPanel,
      updatePanelTitle: h.updatePanelTitle,
    }),
  },
}))

import { useCateHostActionResponder } from './useCateHostActionResponder'

// Capture the action callback main would invoke, and the replies the hook sends.
let actionCb: ((payload: unknown) => unknown) | null = null
const replies: Array<{ requestId: string; ok: boolean; result?: unknown; error?: string }> = []

function installElectronAPI(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onCateHostAction: (cb: (payload: unknown) => unknown) => {
      actionCb = cb
      return () => { actionCb = null }
    },
    cateHostActionReply: (payload: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
      replies.push(payload)
    },
  }
}

function Harness(): React.ReactElement | null {
  useCateHostActionResponder()
  return null
}

let container: HTMLDivElement
let root: Root

/** Fire one forwarded action and wait for the hook's async handler + reply. */
async function fire(method: string, args: unknown, extra?: Partial<{ panelId: string; extensionId: string }>): Promise<void> {
  await act(async () => {
    await actionCb!({
      requestId: `req-${method}`,
      workspaceId: WS,
      panelId: extra?.panelId ?? 'host-panel',
      extensionId: extra?.extensionId ?? 'cate.kitchensink',
      method,
      args,
    })
  })
}

// The placement a keybind (Cmd+T / Cmd+N) would compute for the active panel.
// A distinctive non-center value proves the responder reuses placementForActivePanel
// rather than the old hardcoded center dock.
const ACTIVE_PLACEMENT = { target: 'dock', zone: 'left', stackId: 'stack-9' }

beforeEach(() => {
  vi.clearAllMocks()
  h.placementForActivePanel.mockReturnValue(ACTIVE_PLACEMENT)
  actionCb = null
  replies.length = 0
  installElectronAPI()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<Harness />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('useCateHostActionResponder', () => {
  it('subscribes once mounted', () => {
    expect(actionCb).toBeTypeOf('function')
  })

  it('opens a file with the keybind placement (active panel), not a hardcoded dock', async () => {
    await fire('cate.editor.openFile', { path: 'package.json' })

    // Relative path resolved against the workspace root, and placed exactly where
    // a Cmd+N would put it (placementForActivePanel), not always center-dock.
    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, `${ROOT}/package.json`, undefined, ACTIVE_PLACEMENT)
    expect(h.placementForActivePanel).toHaveBeenCalled()
    expect(h.revealPanel).toHaveBeenCalledWith(WS, 'new-editor-id')
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: true, result: { panelId: 'new-editor-id' } })
  })

  it('honors an optional { line } via a one-shot editor reveal (the search/link path)', async () => {
    await fire('cate.editor.openFile', { path: 'src/app.ts', line: 42, column: 7 })
    expect(h.setPendingReveal).toHaveBeenCalledWith('new-editor-id', { line: 42, column: 7 })
  })

  it('does not set a reveal when no line is given', async () => {
    await fire('cate.editor.openFile', { path: 'src/app.ts' })
    expect(h.setPendingReveal).not.toHaveBeenCalled()
  })

  it('falls back to the default (undefined) placement when no panel is active', async () => {
    // placementForActivePanel returns undefined → the create call gets the
    // workspace's default (primary-canvas) placement, same as a keybind with
    // nothing focused.
    h.placementForActivePanel.mockReturnValue(undefined)
    await fire('cate.editor.openFile', { path: 'package.json' })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, `${ROOT}/package.json`, undefined, undefined)
  })

  it('passes an already-absolute openFile path through unchanged', async () => {
    await fire('cate.editor.openFile', { path: '/etc/hosts' })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, '/etc/hosts', undefined, ACTIVE_PLACEMENT)
  })

  it('rejects openFile with no path', async () => {
    await fire('cate.editor.openFile', {})
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'path required' })
  })

  it('creates an extension panel via canvas.createPanel(extension)', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension', extensionPanelId: 'main' })

    expect(h.createExtensionPanel).toHaveBeenCalledWith(WS, 'cate.kitchensink', 'main', undefined, ACTIVE_PLACEMENT)
    expect(h.revealPanel).toHaveBeenCalledWith(WS, 'new-ext-id')
    expect(replies).toContainEqual({ requestId: 'req-cate.canvas.createPanel', ok: true, result: { panelId: 'new-ext-id' } })
  })

  it('honors an explicit { position } by placing on the canvas at that point', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension', extensionPanelId: 'main', position: { x: 120, y: 80 } })
    expect(h.createExtensionPanel).toHaveBeenCalledWith(WS, 'cate.kitchensink', 'main', undefined, { target: 'canvas', position: { x: 120, y: 80 } })
    // An explicit position overrides the keybind placement entirely.
    expect(h.placementForActivePanel).not.toHaveBeenCalled()
  })

  it('rejects a createPanel(extension) with no extensionPanelId', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension' })
    expect(h.createExtensionPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.canvas.createPanel', ok: false, error: 'extensionPanelId required' })
  })

  it('resolves a relative filePath when createPanel spawns a non-extension type', async () => {
    await fire('cate.canvas.createPanel', { type: 'editor', filePath: 'src/index.ts' })
    expect(h.editorCreate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, placement: ACTIVE_PLACEMENT, filePath: `${ROOT}/src/index.ts` }),
    )
  })

  it('rejects an unknown panel type', async () => {
    await fire('cate.canvas.createPanel', { type: 'bogus' })
    expect(replies).toContainEqual({ requestId: 'req-cate.canvas.createPanel', ok: false, error: 'unknown panel type' })
  })

  it('retitles the host panel via panel.setTitle', async () => {
    await fire('cate.panel.setTitle', { title: 'Renamed' }, { panelId: 'host-panel' })
    expect(h.updatePanelTitle).toHaveBeenCalledWith(WS, 'host-panel', 'Renamed')
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.setTitle', ok: true })
  })

  it('replies unsupported for an unknown method', async () => {
    await fire('cate.unknown.method', {})
    expect(replies).toContainEqual({ requestId: 'req-cate.unknown.method', ok: false, error: 'unsupported' })
  })
})
