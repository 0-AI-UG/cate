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

  it('focuses + centers the panel it opens so it lands in view (open-focus fix)', async () => {
    const store = createCanvasStore()
    // The app adds a canvas node for the new panel; simulate it for the id the
    // mocked createBrowser returns so focusAndCenter has a node to act on.
    store.getState().addNode('panel-br', 'browser', { x: 800, y: 800 }, { width: 100, height: 100 })
    const res = await execOpenPanel({ type: 'browser', target: { url: 'https://example.com' } }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect(store.getState().focusedNodeId).toBe(store.getState().nodeForPanel('panel-br'))
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

import { execFocusPanel, execResizePanel, execArrange } from './cateExecutors'
import { execRunInTerminal, execOpenUrl, execReadTerminal } from './cateExecutors'
import { execLayout, execPanel, execBrowser, execTerminal } from './cateExecutors'

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

  it('read_terminal returns the trailing buffer lines as text', async () => {
    const lines = ['$ echo hi', 'hi', '', '']
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({
      ptyId: 'pty-1',
      terminal: { buffer: { active: {
        length: lines.length,
        getLine: (i: number) => ({ translateToString: () => lines[i] }),
      } } },
    } as any)
    const res = await execReadTerminal({ panelId: 'panel-tm' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    // Trailing blank rows are trimmed.
    expect((res.result as any).text).toBe('$ echo hi\nhi')
    expect((res.result as any).lineCount).toBe(2)
  })

  it('read_terminal errors when the terminal is not live', async () => {
    vi.mocked(terminalRegistry.getEntry).mockReturnValue(undefined as any)
    const res = await execReadTerminal({ panelId: 'gone' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no live terminal/i)
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

  it('open_panel editor with target.preview:true turns on markdown preview', async () => {
    const res = await execOpenPanel({ type: 'editor', target: { path: 'README.md', preview: true } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created.find((c: any[]) => c[0] === 'mdpreview')).toEqual(['mdpreview', 'w1', 'panel-ed', true])
  })
})

// ---------------------------------------------------------------------------
// Consolidated op routers (4-tool surface: layout / panel / browser / terminal)
// ---------------------------------------------------------------------------

describe('execLayout (op router)', () => {
  it("defaults to reading the canvas layout", async () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-ed', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execLayout({}, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panels).toBeDefined()
  })

  it("routes op:'arrange' to arrange panels with the given style", async () => {
    const store = createCanvasStore()
    store.getState().addNode('p1', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    store.getState().addNode('p2', 'editor', { x: 300, y: 0 }, { width: 100, height: 100 })
    const res = await execLayout({ op: 'arrange', style: 'grid' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).layout).toBe('grid')
  })
})

describe('execBrowser', () => {
  beforeEach(async () => {
    const mod: any = await import('../../renderer/stores/appStore')
    mod.__created.length = 0
  })

  it('opens a browser at a url when no panelId is given', async () => {
    const res = await execBrowser({ url: 'https://example.com' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panelId).toBe('panel-br')
  })

  it('rejects a non-url', async () => {
    const res = await execBrowser({ url: 'not a url' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })
})

describe('execPanel (op router)', () => {
  beforeEach(async () => {
    const mod: any = await import('../../renderer/stores/appStore')
    mod.__created.length = 0
    mod.__closed.length = 0
  })

  it("routes op:'open' to open a panel", async () => {
    const res = await execPanel({ op: 'open', type: 'editor', target: { path: 'a.ts' } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panelId).toBe('panel-ed')
  })

  it("routes op:'close' to close a panel", async () => {
    const res = await execPanel({ op: 'close', panelId: 'panel-ed' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__closed[0]).toEqual(['w1', 'panel-ed'])
  })

  it("routes op:'focus' to focus a node", async () => {
    const store = createCanvasStore()
    store.getState().addNode('panel-ed', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execPanel({ op: 'focus', panelId: 'panel-ed' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect(store.getState().focusedNodeId).toBe(store.getState().nodeForPanel('panel-ed'))
  })

  it('rejects an unknown op', async () => {
    const res = await execPanel({ op: 'teleport', panelId: 'x' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown op/i)
  })
})

describe('execTerminal (op router)', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({ ptyId: 'pty-1' } as any)
  })

  it("routes op:'run' to run a command", async () => {
    const res = await execTerminal({ op: 'run', command: 'ls', newPanel: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-1', 'ls\r')
  })

  it("routes op:'read' to read the terminal buffer", async () => {
    const lines = ['output line', '']
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({
      ptyId: 'pty-1',
      terminal: { buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } } },
    } as any)
    const res = await execTerminal({ op: 'read', panelId: 'panel-tm' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).text).toBe('output line')
  })

  it('rejects an unknown op', async () => {
    const res = await execTerminal({ op: 'beam' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown op/i)
  })
})
