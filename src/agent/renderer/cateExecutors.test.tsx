import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execGetLayout, execOpenPanel, execClosePanel } from './cateExecutors'
import { createCanvasStore } from '../../renderer/stores/canvasStore'
import { openFileAsPanel } from '../../renderer/lib/fileRouting'
import type { CateControlContext } from './cateControl'

// The cateExecutors -> cateControl -> agentStore/settingsStore chain pulls in
// electron-log via lib/logger, whose import-time side effects hang under jsdom.
// Mirror the drag-harness mock so the module graph loads cleanly.
vi.mock('../../renderer/lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

// execOpenPanel routes file opens through openFileAsPanel (not createEditor directly).
vi.mock('../../renderer/lib/fileRouting', () => ({
  openFileAsPanel: vi.fn(() => 'panel-ed'),
}))
vi.mock('../../renderer/lib/editorReveal', () => ({
  setPendingReveal: vi.fn(),
}))

// Mock appStore module so executors call into controllable spies.
vi.mock('../../renderer/stores/appStore', () => {
  const created: any[] = []
  const closed: any[] = []
  return {
    __created: created,
    __closed: closed,
    useAppStore: {
      getState: () => ({
        createEditor: (...a: any[]) => { created.push(['editor', ...a]); return 'panel-ed' },
        createTerminal: (...a: any[]) => { created.push(['terminal', ...a]); return 'panel-tm' },
        createBrowser: (...a: any[]) => { created.push(['browser', ...a]); return 'panel-br' },
        createDocument: (...a: any[]) => { created.push(['document', ...a]); return 'panel-doc' },
        createGit: (...a: any[]) => { created.push(['git', ...a]); return 'panel-gt' },
        createFileExplorer: (...a: any[]) => { created.push(['fileExplorer', ...a]); return 'panel-fe' },
        closePanel: (...a: any[]) => { closed.push(a) },
        updatePanelUrl: (...a: any[]) => { created.push(['url', ...a]) },
        setPanelMarkdownPreview: (...a: any[]) => { created.push(['mdpreview', ...a]) },
        workspaces: [{ id: 'w1', panels: { 'panel-ed': { id: 'panel-ed', type: 'editor', title: 'a.ts', filePath: 'a.ts' } } }],
        selectedWorkspaceId: 'w1',
      }),
    },
  }
})

function ctxWith(store = createCanvasStore()): CateControlContext {
  return { workspaceId: 'w1', hostPanelId: 'host', canvasStore: store }
}

describe('execOpenPanel', () => {
  beforeEach(async () => {
    const mod: any = await import('../../renderer/stores/appStore')
    mod.__created.length = 0
    mod.__closed.length = 0
    vi.mocked(openFileAsPanel).mockClear()
  })

  it('opens an editor with a file path via openFileAsPanel and returns the panelId', async () => {
    const res = await execOpenPanel({ type: 'editor', target: { path: 'a.ts' } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panelId).toBe('panel-ed')
    expect(openFileAsPanel).toHaveBeenCalledWith('w1', 'a.ts')
  })

  it('opens a blank editor via createEditor when no path is given', async () => {
    await execOpenPanel({ type: 'editor' }, ctxWith(), 'k1')
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created[0][0]).toBe('editor')
  })

  it('rejects an unknown panel type', async () => {
    const res = await execOpenPanel({ type: 'hologram' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/type/i)
  })
})

describe('execClosePanel', () => {
  it('errors when the panel is not found', async () => {
    const res = await execClosePanel({ panelId: 'nope' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('closes a known panel', async () => {
    const res = await execClosePanel({ panelId: 'panel-ed' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__closed[0]).toEqual(['w1', 'panel-ed'])
  })
})

describe('execGetLayout', () => {
  it('returns panels with isSelf flag and viewport', async () => {
    const store = createCanvasStore()
    store.getState().addNode('host', 'agent', { x: 0, y: 0 }, { width: 200, height: 200 })
    store.getState().addNode('panel-ed', 'editor', { x: 300, y: 0 }, { width: 200, height: 200 })
    const res = await execGetLayout({}, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    const panels = (res.result as any).panels as any[]
    const self = panels.find((p) => p.panelId === 'host')
    expect(self.isSelf).toBe(true)
    expect((res.result as any).viewport).toBeDefined()
  })
})

import { execFocusPanel, execResizePanel, execArrange, execZoom } from './cateExecutors'
import { execRunInTerminal, execOpenUrl, execRevealInEditor, execPanTo } from './cateExecutors'

vi.mock('../../renderer/lib/terminalRegistry', () => ({
  terminalRegistry: { getEntry: vi.fn(() => ({ ptyId: 'pty-1' })) },
}))

describe('management executors', () => {
  it('focus errors on unknown panel', async () => {
    const res = await execFocusPanel({ panelId: 'nope' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('focuses a known node', async () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-ed', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execFocusPanel({ panelId: 'panel-ed' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect(store.getState().focusedNodeId).toBe(store.getState().nodeForPanel('panel-ed'))
  })

  it('resize applies a preset size', async () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-ed', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execResizePanel({ panelId: 'panel-ed', preset: 'large' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    const node = store.getState().nodeForPanel('panel-ed')!
    expect(store.getState().nodes[node].size.width).toBeGreaterThan(100)
  })

  it('zoom fit calls zoomToFit', async () => {
    const store = createCanvasStore()
    const spy = vi.spyOn(store.getState(), 'zoomToFit')
    const res = await execZoom({ level: 'fit' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalled()
  })
})

describe('content executors', () => {
  it('run_in_terminal writes the command to the PTY (newPanel)', async () => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    const res = await execRunInTerminal({ command: 'ls', newPanel: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-1', 'ls\r')
  })

  it('run_in_terminal rejects an empty command', async () => {
    const res = await execRunInTerminal({ command: '   ' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('open_url creates a browser panel when no panelId given', async () => {
    const res = await execOpenUrl({ url: 'https://example.com' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panelId).toBe('panel-br')
  })

  it('open_url rejects a non-url', async () => {
    const res = await execOpenUrl({ url: 'not a url' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('reveal_in_editor routes through openFileAsPanel', async () => {
    const res = await execRevealInEditor({ path: 'a.ts', line: 10 }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect(openFileAsPanel).toHaveBeenCalledWith('w1', 'a.ts')
  })

  it('pan_to errors on an unknown panel', async () => {
    const res = await execPanTo({ panelId: 'nope' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Regression fixes from live testing (2026-05-31)
// ---------------------------------------------------------------------------
import { terminalRegistry } from '../../renderer/lib/terminalRegistry'
import { execSetMarkdownPreview } from './cateExecutors'

describe('terminal command reliability (Issue 1 fix)', () => {
  beforeEach(async () => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({ ptyId: 'pty-1' } as any)
    const mod: any = await import('../../renderer/stores/appStore')
    mod.__created.length = 0
  })

  it('run_in_terminal polls until the PTY registers, then writes the command', async () => {
    // Not ready for the first two polls (no entry, then entry with empty ptyId),
    // then the PTY spawns — proves condition-based waiting, not a fixed delay.
    let calls = 0
    vi.mocked(terminalRegistry.getEntry).mockImplementation(() => {
      calls += 1
      if (calls === 1) return undefined as any
      if (calls === 2) return { ptyId: '' } as any
      return { ptyId: 'pty-9' } as any
    })
    const res = await execRunInTerminal({ command: 'npm test', newPanel: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-9', 'npm test\r')
  })

  it('open_panel(terminal, command) runs the command via the PTY, not the dropped initialInput path', async () => {
    const res = await execOpenPanel({ type: 'terminal', target: { command: 'npm test' } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-1', 'npm test\r')
    // createTerminal must NOT receive the command as initialInput (that arg is a no-op via the store).
    const mod: any = await import('../../renderer/stores/appStore')
    const termCreate = mod.__created.find((c: any[]) => c[0] === 'terminal')
    expect(termCreate?.[2]).toBeUndefined()
  })
})

describe('markdown preview (Issue 2 fix)', () => {
  beforeEach(async () => {
    const mod: any = await import('../../renderer/stores/appStore')
    mod.__created.length = 0
  })

  it('set_markdown_preview toggles preview on an editor panel', async () => {
    const res = await execSetMarkdownPreview({ panelId: 'panel-ed', preview: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created.find((c: any[]) => c[0] === 'mdpreview')).toEqual(['mdpreview', 'w1', 'panel-ed', true])
  })

  it('set_markdown_preview errors when the panel is missing', async () => {
    const res = await execSetMarkdownPreview({ panelId: 'nope', preview: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('reveal_in_editor with preview:true turns on markdown preview', async () => {
    const res = await execRevealInEditor({ path: 'README.md', preview: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created.find((c: any[]) => c[0] === 'mdpreview')).toEqual(['mdpreview', 'w1', 'panel-ed', true])
  })
})
