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
const WORKTREE_ROOT = '/Users/dev/checkouts/feature'
// A REMOTE workspace: the store holds a locator URI as rootPath, but
// cate.workspace.get hands the extension the BARE path (/srv/proj). An absolute
// path the extension echoes back must resolve against the bare form.
const REMOTE_WS = 'ws-remote'
const REMOTE_ROOT_BARE = '/srv/proj'
const REMOTE_ROOT_LOCATOR = `cate-runtime://srv_a1${REMOTE_ROOT_BARE}`

const h = vi.hoisted(() => ({
  openFileAsPanel: vi.fn(() => 'new-editor-id'),
  revealPanel: vi.fn(async () => true),
  closePanelWithConfirm: vi.fn(async () => true),
  createExtensionPanel: vi.fn(() => 'new-ext-id'),
  updatePanelTitle: vi.fn(),
  editorCreate: vi.fn(() => 'reg-editor-id'),
  createTerminal: vi.fn(() => 'new-terminal-id'),
  setPanelWorktreeId: vi.fn(),
  placementForBackgroundPanel: vi.fn(),
  setPendingReveal: vi.fn(),
  activePanelId: null as string | null,
}))

const terminalDriver = vi.hoisted(() => ({
  handleTerminalMethod: vi.fn(async (
    _workspaceId: string,
    _method: string,
    _args: unknown,
    onTargetResolved?: (panelId: string) => void,
  ) => {
    onTargetResolved?.('t1')
    return { ok: true as const, result: { panelId: 't1', alt: false, text: 'x' } }
  }),
}))
vi.mock('../lib/terminal/terminalDriver', () => ({ handleTerminalMethod: terminalDriver.handleTerminalMethod }))

vi.mock('../lib/fs/fileRouting', () => ({ openFileAsPanel: h.openFileAsPanel }))
vi.mock('../lib/workspace/panelReveal', () => ({ revealPanel: h.revealPanel }))
vi.mock('../lib/workspace/canvasAccess', () => ({ placementForBackgroundPanel: h.placementForBackgroundPanel }))
vi.mock('../lib/closePanelWithConfirm', () => ({ closePanelWithConfirm: h.closePanelWithConfirm }))
vi.mock('../lib/editor/editorReveal', () => ({ setPendingReveal: h.setPendingReveal }))
vi.mock('../lib/activePanel', () => ({ getActivePanelId: () => h.activePanelId }))
vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../panels/registry', () => ({
  PANEL_REGISTRY: {
    terminal: { create: vi.fn() },
    editor: { create: h.editorCreate },
    extension: { create: vi.fn() },
  },
}))
vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      // `host-panel` lives in THIS window's store; a detached panel would be
      // absent (drives the panel.setTitle not-in-window reply).
      workspaces: [
        {
          id: WS,
          rootPath: ROOT,
          worktrees: [{ id: 'wt-feature', path: WORKTREE_ROOT }],
          panels: {
            'host-panel': { id: 'host-panel', type: 'terminal', title: 'Term' },
            'ed-1': { id: 'ed-1', type: 'editor', title: 'a.ts', filePath: `${ROOT}/src/a.ts` },
            'br-1': {
              id: 'br-1',
              type: 'browser',
              title: 'Docs',
              tabs: [{ id: 'br-1-tab', url: 'https://docs.example/', title: '' }],
              activeTabId: 'br-1-tab',
            },
            'br-2': {
              id: 'br-2',
              type: 'browser',
              title: 'New Tab',
              tabs: [{ id: 'br-2-tab', url: 'cate://newtab', title: '' }],
              activeTabId: 'br-2-tab',
            },
          },
        },
        { id: REMOTE_WS, rootPath: REMOTE_ROOT_LOCATOR, panels: {} },
      ],
      createExtensionPanel: h.createExtensionPanel,
      createTerminal: h.createTerminal,
      setPanelWorktreeId: h.setPanelWorktreeId,
      updatePanelTitle: h.updatePanelTitle,
    }),
  },
}))

import { useCateHostActionResponder } from './useCateHostActionResponder'
import { clearPanelInteractions, usePanelInteractionStore } from '../lib/panelInteractions'

// Capture the action callback main would invoke, and the replies the hook sends.
let actionCb: ((payload: unknown) => unknown) | null = null
const replies: Array<{ requestId: string; ok: boolean; result?: unknown; error?: string }> = []

// openFile stats its target before opening; default to "exists, is a file".
const fsStat = vi.fn(async (_path: string, _workspaceId?: string) => ({ isDirectory: false, isFile: true }))

function installElectronAPI(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onCateHostAction: (cb: (payload: unknown) => unknown) => {
      actionCb = cb
      return () => { actionCb = null }
    },
    cateHostActionReply: (payload: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
      replies.push(payload)
    },
    fsStat,
  }
}

function Harness(): React.ReactElement | null {
  useCateHostActionResponder()
  return null
}

let container: HTMLDivElement
let root: Root

/** Fire one forwarded action and wait for the hook's async handler + reply. */
async function fire(method: string, args: unknown, extra?: Partial<{ panelId: string; extensionId: string; workspaceId: string; originCwd: string }>): Promise<void> {
  await act(async () => {
    await actionCb!({
      requestId: `req-${method}`,
      workspaceId: extra?.workspaceId ?? WS,
      panelId: extra?.panelId ?? 'host-panel',
      extensionId: extra?.extensionId ?? 'cate.kitchensink',
      method,
      args,
      originCwd: extra?.originCwd,
    })
  })
}

const BACKGROUND_PLACEMENT = { target: 'canvas', canvasPanelId: 'canvas-1', focus: false }

beforeEach(() => {
  vi.clearAllMocks()
  clearPanelInteractions()
  fsStat.mockResolvedValue({ isDirectory: false, isFile: true })
  h.placementForBackgroundPanel.mockReturnValue(BACKGROUND_PLACEMENT)
  h.activePanelId = null
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
  clearPanelInteractions()
})

describe('useCateHostActionResponder', () => {
  it('subscribes once mounted', () => {
    expect(actionCb).toBeTypeOf('function')
  })

  it('opens a file with background placement and does not reveal/focus it', async () => {
    await fire('cate.editor.openFile', { path: 'package.json' })

    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, `${ROOT}/package.json`, undefined, BACKGROUND_PLACEMENT)
    expect(h.placementForBackgroundPanel).toHaveBeenCalled()
    expect(h.revealPanel).not.toHaveBeenCalled()
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

  it('uses unpinned background canvas placement when no canvas is active', async () => {
    h.placementForBackgroundPanel.mockReturnValue({ target: 'canvas', focus: false })
    await fire('cate.editor.openFile', { path: 'package.json' })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, `${ROOT}/package.json`, undefined, { target: 'canvas', focus: false })
  })

  it('rejects openFile for a nonexistent path instead of opening an empty panel', async () => {
    fsStat.mockRejectedValueOnce(new Error('ENOENT'))
    await fire('cate.editor.openFile', { path: 'missing-file.txt' })
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'file-not-found' })
  })

  it('rejects openFile for a directory', async () => {
    fsStat.mockResolvedValueOnce({ isDirectory: true, isFile: false })
    await fire('cate.editor.openFile', { path: 'src' })
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'path is a directory' })
  })

  it('rejects an absolute openFile path that escapes the workspace root', async () => {
    await fire('cate.editor.openFile', { path: '/etc/hosts' })
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'path outside workspace' })
  })

  it('rejects a relative openFile path that traverses out of the workspace root', async () => {
    await fire('cate.editor.openFile', { path: '../../etc/passwd' })
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'path outside workspace' })
  })

  it('allows an absolute openFile path that is inside the workspace root', async () => {
    await fire('cate.editor.openFile', { path: `${ROOT}/src/app.ts` })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(WS, `${ROOT}/src/app.ts`, undefined, BACKGROUND_PLACEMENT)
  })

  it('resolves a CLI-relative file from the caller worktree instead of the primary checkout', async () => {
    await fire('cate.editor.openFile', { path: 'src/app.ts' }, {
      originCwd: `${WORKTREE_ROOT}/packages/client`,
    })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(
      WS,
      `${WORKTREE_ROOT}/packages/client/src/app.ts`,
      undefined,
      BACKGROUND_PLACEMENT,
    )
  })

  it('allows an absolute path inside a registered sibling worktree', async () => {
    await fire('cate.editor.openFile', { path: `${WORKTREE_ROOT}/src/app.ts` })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(
      WS,
      `${WORKTREE_ROOT}/src/app.ts`,
      undefined,
      BACKGROUND_PLACEMENT,
    )
  })

  it('accepts an absolute path inside a REMOTE workspace (locator rootPath) and re-attaches the scheme', async () => {
    // Regression: for a remote workspace the store's rootPath is a locator URI,
    // but workspace.get gives the extension the BARE path. An absolute path the
    // extension echoes back (/srv/proj/src/app.ts) must clear the containment
    // check against the bare root — not be rejected as "outside workspace" — and
    // must reach the open path re-encoded as a locator so it routes to the runtime.
    await fire('cate.editor.openFile', { path: `${REMOTE_ROOT_BARE}/src/app.ts` }, { workspaceId: REMOTE_WS })
    expect(h.openFileAsPanel).toHaveBeenCalledWith(
      REMOTE_WS,
      `${REMOTE_ROOT_LOCATOR}/src/app.ts`,
      undefined,
      BACKGROUND_PLACEMENT,
    )
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: true, result: { panelId: 'new-editor-id' } })
  })

  it('rejects openFile with no path', async () => {
    await fire('cate.editor.openFile', {})
    expect(h.openFileAsPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.editor.openFile', ok: false, error: 'path required' })
  })

  it('creates an extension panel via canvas.createPanel(extension)', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension', extensionPanelId: 'main' })

    expect(h.createExtensionPanel).toHaveBeenCalledWith(WS, 'cate.kitchensink', 'main', undefined, BACKGROUND_PLACEMENT)
    expect(h.revealPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.canvas.createPanel', ok: true, result: { panelId: 'new-ext-id' } })
  })

  it('honors an explicit { position } by placing on the canvas at that point', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension', extensionPanelId: 'main', position: { x: 120, y: 80 } })
    expect(h.createExtensionPanel).toHaveBeenCalledWith(WS, 'cate.kitchensink', 'main', undefined, {
      ...BACKGROUND_PLACEMENT,
      position: { x: 120, y: 80 },
    })
  })

  it('rejects a createPanel(extension) with no extensionPanelId', async () => {
    await fire('cate.canvas.createPanel', { type: 'extension' })
    expect(h.createExtensionPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.canvas.createPanel', ok: false, error: 'extensionPanelId required' })
  })

  it('resolves a relative filePath when createPanel spawns a non-extension type', async () => {
    await fire('cate.canvas.createPanel', { type: 'editor', filePath: 'src/index.ts' })
    expect(h.editorCreate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, placement: BACKGROUND_PLACEMENT, filePath: `${ROOT}/src/index.ts` }),
    )
  })

  it('resolves createPanel file paths from a CLI caller worktree', async () => {
    await fire('cate.canvas.createPanel', { type: 'editor', filePath: 'src/index.ts' }, {
      originCwd: WORKTREE_ROOT,
    })
    expect(h.editorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        placement: BACKGROUND_PLACEMENT,
        filePath: `${WORKTREE_ROOT}/src/index.ts`,
      }),
    )
  })

  it('creates a terminal at the containing CLI caller worktree', async () => {
    await fire('cate.canvas.createPanel', { type: 'terminal' }, {
      originCwd: `${WORKTREE_ROOT}/packages/client`,
    })

    expect(h.createTerminal).toHaveBeenCalledWith(
      WS,
      undefined,
      undefined,
      BACKGROUND_PLACEMENT,
      WORKTREE_ROOT,
    )
    expect(h.setPanelWorktreeId).toHaveBeenCalledWith(WS, 'new-terminal-id', 'wt-feature')
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

  it('rejects panel.setTitle for a panel not in this window (e.g. detached), instead of a silent no-op', async () => {
    // A panel detached into another window was removed from THIS window's store,
    // so updatePanelTitle would no-op. The responder must report the failure
    // rather than reply ok:true (a silent lie to the extension).
    await fire('cate.panel.setTitle', { title: 'Renamed' }, { panelId: 'detached-panel' })
    expect(h.updatePanelTitle).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.setTitle', ok: false, error: 'panel-not-in-window' })
  })

  it('replies unsupported for an unknown method', async () => {
    await fire('cate.unknown.method', {})
    expect(replies).toContainEqual({ requestId: 'req-cate.unknown.method', ok: false, error: 'unsupported' })
  })

  it('panel.list enumerates this window panels: focus, bare filePath, browser url', async () => {
    h.activePanelId = 'ed-1'
    await fire('cate.panel.list', {})
    expect(replies).toContainEqual({
      requestId: 'req-cate.panel.list',
      ok: true,
      result: [
        { panelId: 'host-panel', type: 'terminal', title: 'Term', focused: false },
        { panelId: 'ed-1', type: 'editor', title: 'a.ts', focused: true, filePath: `${ROOT}/src/a.ts` },
        { panelId: 'br-1', type: 'browser', title: 'Docs', focused: false, url: 'https://docs.example/' },
        // Start-page urls normalize to '' — the caller sees "no real page yet".
        { panelId: 'br-2', type: 'browser', title: 'New Tab', focused: false, url: '' },
      ],
    })
  })

  it('panel.focus reveals the panel; an absent one is rejected', async () => {
    await fire('cate.panel.focus', { panelId: 'ed-1' })
    expect(h.revealPanel).toHaveBeenCalledWith(WS, 'ed-1')
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.focus', ok: true })

    await fire('cate.panel.focus', { panelId: 'detached-panel' })
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.focus', ok: false, error: 'panel-not-in-window' })
  })

  it('panel.focus reports failure when the panel record cannot be revealed', async () => {
    h.revealPanel.mockResolvedValueOnce(false)
    await fire('cate.panel.focus', { panelId: 'ed-1' })
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.focus', ok: false, error: 'panel-not-revealable' })
  })

  it('panel.close closes through the confirmation path without revealing it', async () => {
    await fire('cate.panel.close', { panelId: 'ed-1' })
    expect(h.closePanelWithConfirm).toHaveBeenCalledWith(WS, 'ed-1')
    expect(h.revealPanel).not.toHaveBeenCalled()
    expect(replies).toContainEqual({ requestId: 'req-cate.panel.close', ok: true })
  })

  it('delegates cate.terminal.* to the terminal driver and relays its result', async () => {
    await fire('cate.terminal.read', { panelId: 't1' })
    expect(terminalDriver.handleTerminalMethod).toHaveBeenCalledWith(
      WS,
      'cate.terminal.read',
      { panelId: 't1' },
      expect.any(Function),
    )
    expect(replies).toContainEqual({
      requestId: 'req-cate.terminal.read',
      ok: true,
      result: { panelId: 't1', alt: false, text: 'x' },
    })
    expect(Object.values(usePanelInteractionStore.getState().interactions)[0]).toMatchObject({
      workspaceId: WS,
      sourcePanelId: 'host-panel',
      targetPanelId: 't1',
      kind: 'read',
      phase: 'active',
    })
  })

  it('relays a terminal-driver error verbatim', async () => {
    terminalDriver.handleTerminalMethod.mockResolvedValueOnce({ ok: false, error: 'no-terminal-focused' } as never)
    await fire('cate.terminal.read', {})
    expect(replies).toContainEqual({ requestId: 'req-cate.terminal.read', ok: false, error: 'no-terminal-focused' })
  })

})
