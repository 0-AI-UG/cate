import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createCanvasStore } from '../../renderer/stores/canvasStore'
import { openFileAsPanel } from '../../renderer/lib/fileRouting'
import { terminalRegistry } from '../../renderer/lib/terminalRegistry'
import { portalRegistry } from '../../renderer/lib/portalRegistry'
import type { CateControlContext } from './cateControl'
import {
  execGetLayout, execOpenPanel, execClosePanel, execMovePanel,
  execRunInTerminal, execReadTerminal,
  execPanel, execBrowser, execTerminal,
} from './cateExecutors'

// The cateExecutors -> cateControl -> agentStore/settingsStore chain pulls in
// electron-log via lib/logger, whose import-time side effects hang under jsdom.
// Mirror the drag-harness mock so the module graph loads cleanly.
vi.mock('../../renderer/lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

// execOpenPanel routes file opens through openFileAsPanel (not createEditor directly).
vi.mock('../../renderer/lib/fileRouting', () => ({
  openFileAsPanel: vi.fn(() => 'ed-panel'),
}))
vi.mock('../../renderer/lib/editorReveal', () => ({
  setPendingReveal: vi.fn(),
}))
vi.mock('../../renderer/lib/terminalRegistry', () => ({
  terminalRegistry: { getEntry: vi.fn(() => ({ ptyId: 'pty-1' })) },
}))

// Mock appStore module so executors call into controllable spies. The workspace
// panels carry titles so resolvePanelRef (title -> panelId) has something to map.
vi.mock('../../renderer/stores/appStore', () => {
  const created: any[] = []
  const closed: any[] = []
  return {
    __created: created,
    __closed: closed,
    useAppStore: {
      getState: () => ({
        createEditor: (...a: any[]) => { created.push(['editor', ...a]); return 'ed-panel' },
        createTerminal: (...a: any[]) => { created.push(['terminal', ...a]); return 'tm-panel' },
        createBrowser: (...a: any[]) => { created.push(['browser', ...a]); return 'br-panel' },
        createDocument: (...a: any[]) => { created.push(['document', ...a]); return 'doc-panel' },
        closePanel: (...a: any[]) => { closed.push(a) },
        updatePanelUrl: (...a: any[]) => { created.push(['url', ...a]) },
        setPanelMarkdownPreview: (...a: any[]) => { created.push(['mdpreview', ...a]) },
        workspaces: [{ id: 'w1', panels: {
          // The agent-facing id is the first 6 chars of these (e.g. "ed-pan");
          // they're given distinct 6-char prefixes so the short ids don't collide.
          'ed-panel': { id: 'ed-panel', type: 'editor', title: 'a.ts', filePath: 'a.ts' },
          'tm-panel': { id: 'tm-panel', type: 'terminal', title: 'Terminal 1' },
          'br-panel': { id: 'br-panel', type: 'browser', title: 'Browser' },
        } }],
        selectedWorkspaceId: 'w1',
      }),
    },
  }
})

function ctxWith(store = createCanvasStore()): CateControlContext {
  return { workspaceId: 'w1', hostPanelId: 'host', canvasStore: store }
}

// Result the stubbed browser <webview> returns from executeJavaScript (read/eval).
let browserEvalResult: unknown = ''

beforeEach(async () => {
  const mod: any = await import('../../renderer/stores/appStore')
  mod.__created.length = 0
  mod.__closed.length = 0
  vi.mocked(openFileAsPanel).mockClear()
  vi.mocked(terminalRegistry.getEntry).mockReturnValue({ ptyId: 'pty-1' } as any)
  // Stand in for the live <webview> of the mock 'Browser' panel (id 'br-panel').
  browserEvalResult = ''
  portalRegistry.register('br-panel', {
    getWebContentsId: () => 1,
    getURL: () => 'https://example.com',
    getTitle: () => 'Example',
    loadURL: () => {},
    goBack: () => {}, goForward: () => {}, canGoBack: () => true, canGoForward: () => false,
    reload: () => {}, stop: () => {},
    executeJavaScript: async () => browserEvalResult,
  })
})

describe('execOpenPanel', () => {
  it('opens an editor with a file path via openFileAsPanel and reports its id + title', async () => {
    const res = await execOpenPanel({ type: 'editor', target: { path: 'a.ts' } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).id).toBe('ed-pan')
    expect((res.result as any).title).toBe('a.ts')
    expect((res.result as any).type).toBe('editor')
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

  it('focuses the panel it opens so it lands in view (open-focus fix)', async () => {
    const store = createCanvasStore()
    store.getState().addNode('br-panel', 'browser', { x: 800, y: 800 }, { width: 100, height: 100 })
    const res = await execOpenPanel({ type: 'browser', target: { url: 'https://example.com' } }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect(store.getState().focusedNodeId).toBe(store.getState().nodeForPanel('br-panel'))
  })

  it('never moves the camera and drops the new panel at the viewport center', async () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 1000 })
    store.getState().addNode('br-panel', 'browser', { x: 5000, y: 5000 }, { width: 100, height: 100 })
    const offsetBefore = { ...store.getState().viewportOffset }
    const zoomBefore = store.getState().zoomLevel
    await execOpenPanel({ type: 'browser', target: { url: 'https://example.com' } }, ctxWith(store), 'k1')
    expect(store.getState().viewportOffset).toEqual(offsetBefore)
    expect(store.getState().zoomLevel).toBe(zoomBefore)
    const nodeId = store.getState().nodeForPanel('br-panel')!
    expect(store.getState().nodes[nodeId].origin).toEqual({ x: 450, y: 450 })
  })

  it('opens an editor straight into markdown preview when target.preview is true', async () => {
    const res = await execOpenPanel({ type: 'editor', target: { path: 'README.md', preview: true } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created.find((c: any[]) => c[0] === 'mdpreview')).toEqual(['mdpreview', 'w1', 'ed-panel', true])
  })
})

describe('execClosePanel', () => {
  it('errors when no panel matches the ref', async () => {
    const res = await execClosePanel({ panel: 'nope' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no panel with id/i)
  })

  it('closes a panel addressed by title', async () => {
    const res = await execClosePanel({ panel: 'a.ts' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).closed).toBe('a.ts')
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__closed[0]).toEqual(['w1', 'ed-panel'])
  })

  it('closes a panel addressed by its short id (UUID prefix)', async () => {
    const res = await execClosePanel({ panel: 'ed-pan' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__closed[0]).toEqual(['w1', 'ed-panel'])
  })

  it("refuses to close the agent's own panel", async () => {
    const res = await execClosePanel({ panel: 'self' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/refusing/i)
  })
})

describe('execMovePanel', () => {
  it('moves a panel (by title) relative to another panel', async () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 1000 })
    store.getState().addNode('ed-panel', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    store.getState().addNode('tm-panel', 'terminal', { x: 600, y: 0 }, { width: 100, height: 100 })
    const res = await execMovePanel({ panel: 'a.ts', placement: { relativeTo: 'Terminal 1', position: 'right' } }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).moved).toBe('a.ts')
    // Placed to the right of Terminal 1 (x 600 + width 100 + gap 40 = 740).
    const node = store.getState().nodeForPanel('ed-panel')!
    expect(store.getState().nodes[node].origin.x).toBe(740)
  })

  it("refuses to move the agent's own panel", async () => {
    const res = await execMovePanel({ panel: 'self' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/refusing/i)
  })
})

describe('execGetLayout', () => {
  it('reports panels with a stable id + title/type and an isSelf flag (no raw panelId)', async () => {
    const store = createCanvasStore()
    store.getState().addNode('host', 'agent', { x: 0, y: 0 }, { width: 200, height: 200 })
    store.getState().addNode('ed-panel', 'editor', { x: 300, y: 0 }, { width: 200, height: 200 })
    const res = await execGetLayout({}, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    const panels = (res.result as any).panels as any[]
    expect(panels.some((p) => p.isSelf)).toBe(true)
    expect(panels.find((p) => p.title === 'a.ts')?.type).toBe('editor')
    // the short id (first 6 chars of the panel UUID) is exposed as `id`.
    expect(panels.find((p) => p.title === 'a.ts')?.id).toBe('ed-pan')
    // the raw internal panelId is never leaked.
    expect(panels.every((p) => p.panelId === undefined)).toBe(true)
  })
})

describe('content executors', () => {
  it('run_in_terminal writes the command to a fresh PTY (newPanel)', async () => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    const res = await execRunInTerminal({ command: 'ls', newPanel: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).terminal).toBe('Terminal 1')
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-1', 'ls\r')
  })

  it('run_in_terminal rejects an empty command', async () => {
    const res = await execRunInTerminal({ command: '   ' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('browser navigate points an existing panel (by title) at a url', async () => {
    const res = await execBrowser({ op: 'navigate', panel: 'Browser', url: 'https://example.com' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).browser).toBe('Browser')
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__created.find((c: any[]) => c[0] === 'url')).toEqual(['url', 'w1', 'br-panel', 'https://example.com'])
  })

  it('browser navigate rejects a non-url', async () => {
    const res = await execBrowser({ op: 'navigate', panel: 'Browser', url: 'not a url' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('browser navigate errors when the panel has no live web view', async () => {
    const res = await execBrowser({ op: 'navigate', panel: 'nope', url: 'https://example.com' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
  })

  it('browser read returns a selector\'s text from the page', async () => {
    browserEvalResult = 'hello world'
    const res = await execBrowser({ op: 'read', panel: 'Browser', selector: 'h1' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).text).toBe('hello world')
    expect((res.result as any).selector).toBe('h1')
  })

  it('browser eval returns the (serialized) script result', async () => {
    browserEvalResult = { count: 2 }
    const res = await execBrowser({ op: 'eval', panel: 'Browser', js: 'doStuff()' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).result).toBe('{"count":2}')
  })

  it('browser info reports the current navigation state', async () => {
    const res = await execBrowser({ op: 'info', panel: 'Browser' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).url).toBe('https://example.com')
    expect((res.result as any).canGoBack).toBe(true)
  })

  it('read_terminal (by title) returns the trailing buffer lines as text', async () => {
    const lines = ['$ echo hi', 'hi', '', '']
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({
      ptyId: 'pty-1',
      terminal: { buffer: { active: {
        length: lines.length,
        getLine: (i: number) => ({ translateToString: () => lines[i] }),
      } } },
    } as any)
    const res = await execReadTerminal({ panel: 'Terminal 1' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).text).toBe('$ echo hi\nhi')
    expect((res.result as any).lineCount).toBe(2)
    expect((res.result as any).terminal).toBe('Terminal 1')
  })

  it('read_terminal errors when the terminal is not live', async () => {
    vi.mocked(terminalRegistry.getEntry).mockReturnValue(undefined as any)
    const res = await execReadTerminal({ panel: 'Terminal 1' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no live terminal/i)
  })
})

describe('terminal command reliability', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({ ptyId: 'pty-1' } as any)
  })

  it('run_in_terminal polls until the PTY registers, then writes the command', async () => {
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
    const mod: any = await import('../../renderer/stores/appStore')
    const termCreate = mod.__created.find((c: any[]) => c[0] === 'terminal')
    expect(termCreate?.[2]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Op routers (4-tool surface: layout / panel / browser / terminal)
// ---------------------------------------------------------------------------

describe('op routers', () => {
  it('layout reads the canvas', async () => {
    const store = createCanvasStore()
    store.getState().addNode('ed-panel', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execGetLayout({}, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).panels).toBeDefined()
  })

  it("execPanel routes op:'open'", async () => {
    const res = await execPanel({ op: 'open', type: 'editor', target: { path: 'a.ts' } }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).title).toBe('a.ts')
  })

  it("execPanel routes op:'close' (by title)", async () => {
    const res = await execPanel({ op: 'close', panel: 'a.ts' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    const mod: any = await import('../../renderer/stores/appStore')
    expect(mod.__closed[0]).toEqual(['w1', 'ed-panel'])
  })

  it("execPanel routes op:'move'", async () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 1000, height: 1000 })
    store.getState().addNode('ed-panel', 'editor', { x: 0, y: 0 }, { width: 100, height: 100 })
    const res = await execPanel({ op: 'move', panel: 'a.ts' }, ctxWith(store), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).moved).toBe('a.ts')
  })

  it('execPanel rejects an unknown op', async () => {
    const res = await execPanel({ op: 'teleport', panel: 'x' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown op/i)
  })

  it("execBrowser routes op:'navigate'", async () => {
    const res = await execBrowser({ op: 'navigate', panel: 'Browser', url: 'https://example.com' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).browser).toBe('Browser')
  })

  it('execBrowser rejects an unknown op', async () => {
    const res = await execBrowser({ op: 'teleport', panel: 'Browser' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown op/i)
  })

  it("execTerminal routes op:'run'", async () => {
    ;(window.electronAPI as any).terminalWrite = vi.fn()
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({ ptyId: 'pty-1' } as any)
    const res = await execTerminal({ op: 'run', command: 'ls', newPanel: true }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((window.electronAPI as any).terminalWrite).toHaveBeenCalledWith('pty-1', 'ls\r')
  })

  it("execTerminal routes op:'read'", async () => {
    const lines = ['output line', '']
    vi.mocked(terminalRegistry.getEntry).mockReturnValue({
      ptyId: 'pty-1',
      terminal: { buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } } },
    } as any)
    const res = await execTerminal({ op: 'read', panel: 'Terminal 1' }, ctxWith(), 'k1')
    expect(res.ok).toBe(true)
    expect((res.result as any).text).toBe('output line')
  })

  it('execTerminal rejects an unknown op', async () => {
    const res = await execTerminal({ op: 'beam' }, ctxWith(), 'k1')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown op/i)
  })
})
