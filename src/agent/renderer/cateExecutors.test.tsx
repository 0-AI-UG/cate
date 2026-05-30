import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execGetLayout, execOpenPanel, execClosePanel } from './cateExecutors'
import { createCanvasStore } from '../../renderer/stores/canvasStore'
import { openFileAsPanel } from '../../renderer/lib/fileRouting'
import type { CateControlContext } from './cateControl'

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
