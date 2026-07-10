// =============================================================================
// Regression: detached windows are separate renderer processes with their own
// useAppStore that never bootstraps a workspace. Before the fix the shells kept
// a LOCAL panels map as the de-facto source while panel components' live writes
// (browser tab updates / setPanelDirty / updatePanelFilePath) hit appStore and were
// silently dropped (setPanelField found no workspace). Session capture read the
// stale local map, so a navigated URL or dirty flag was lost on restart.
//
// The fix makes the detached window's appStore the single in-window source of
// truth: ensurePanelsInAppStore seeds a stub workspace; the shell renders FROM
// it; session capture reads FROM it on demand. These tests prove a live edit
// lands in appStore and is what a sync would capture — WITHOUT any
// editor:panel-saved-as mirror event.
// =============================================================================

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { ensurePanelsInAppStore, applyCanvasChildPanels } from './applyCanvasChildPanels'
import { useAppStore } from '../../stores/appStore'
import { browserPanelUrl, type PanelState, type WorktreeMeta } from '../../../shared/types'

const WS = 'detached-ws-1'

/** Mirror the shells' on-demand read at sync time. */
const readPanels = (wsId: string): Record<string, PanelState> =>
  useAppStore.getState().workspaces.find((w) => w.id === wsId)?.panels ?? {}

const browserPanel = (url: string): PanelState => ({
  id: 'b1',
  type: 'browser',
  title: 'Web',
  isDirty: false,
  tabs: [{ id: 'tab-1', url, title: '' }],
  activeTabId: 'tab-1',
})

beforeEach(() => {
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
})

describe('ensurePanelsInAppStore', () => {
  it('creates a stub workspace holding the panels when none exists', () => {
    const browser = browserPanel('https://a.test')
    ensurePanelsInAppStore(WS, { b1: browser })

    const ws = useAppStore.getState().workspaces.find((w) => w.id === WS)
    expect(ws).toBeDefined()
    expect(ws?.panels.b1).toEqual(browser)
    expect(useAppStore.getState().selectedWorkspaceId).toBe(WS)
  })

  it('merges into the existing stub workspace on a later transfer', () => {
    ensurePanelsInAppStore(WS, { b1: browserPanel('https://a.test') })
    ensurePanelsInAppStore(WS, { e1: { id: 'e1', type: 'editor', title: 'Untitled', isDirty: true } })

    const panels = readPanels(WS)
    expect(Object.keys(panels).sort()).toEqual(['b1', 'e1'])
  })

  it('no-ops on empty workspaceId or empty panel map', () => {
    ensurePanelsInAppStore('', { b1: browserPanel('https://a.test') })
    ensurePanelsInAppStore(WS, {})
    expect(useAppStore.getState().workspaces).toHaveLength(0)
  })

  it('applyCanvasChildPanels alias delegates to the same logic', () => {
    applyCanvasChildPanels(WS, { c1: { id: 'c1', type: 'terminal', title: 'zsh', isDirty: false } })
    expect(readPanels(WS).c1).toBeDefined()
  })
})

// Regression: a detached canvas window seeded a stub workspace with an empty
// rootPath, so a newly-created terminal there had no cwd and re-prompted for a
// folder. The transfer now carries the source workspace root.
describe('ensurePanelsInAppStore — rootPath threading', () => {
  const ws = () => useAppStore.getState().workspaces.find((w) => w.id === WS)

  it('seeds the stub workspace rootPath from the transfer', () => {
    ensurePanelsInAppStore(WS, { c1: { id: 'c1', type: 'canvas', title: 'Canvas', isDirty: false } }, '/repo')
    expect(ws()?.rootPath).toBe('/repo')
  })

  it('backfills rootPath onto an existing stub that had none (children arrive later)', () => {
    ensurePanelsInAppStore(WS, { c1: { id: 'c1', type: 'canvas', title: 'Canvas', isDirty: false } })
    expect(ws()?.rootPath).toBe('')
    ensurePanelsInAppStore(WS, { t1: { id: 't1', type: 'terminal', title: 'zsh', isDirty: false } }, '/repo')
    expect(ws()?.rootPath).toBe('/repo')
  })

  it('never clobbers an already-resolved rootPath', () => {
    ensurePanelsInAppStore(WS, { c1: { id: 'c1', type: 'canvas', title: 'Canvas', isDirty: false } }, '/repo')
    ensurePanelsInAppStore(WS, { t1: { id: 't1', type: 'terminal', title: 'zsh', isDirty: false } }, '/other')
    expect(ws()?.rootPath).toBe('/repo')
  })

  it('backfills rootPath with no panels (canvas children deferred)', () => {
    ensurePanelsInAppStore(WS, { c1: { id: 'c1', type: 'canvas', title: 'Canvas', isDirty: false } })
    ensurePanelsInAppStore(WS, {}, '/repo')
    expect(ws()?.rootPath).toBe('/repo')
  })
})

// Regression: a detached window's stub workspace had an empty worktree registry,
// so worktree pills (terminal/agent tab tints + canvas-node badges) rendered
// colorless there — every panel's worktreeId failed to resolve against `[]`. The
// transfer now carries the source worktree records and seeds/merges them here.
describe('ensurePanelsInAppStore — worktree threading', () => {
  const ws = () => useAppStore.getState().workspaces.find((w) => w.id === WS)
  const WT_A: WorktreeMeta = { id: 'wt-a', path: '/repo', color: '#111111', label: 'main' }
  const WT_B: WorktreeMeta = { id: 'wt-b', path: '/repo/.cate/worktrees/b', color: '#22aa55', label: 'feature' }

  it('seeds the stub workspace worktrees from the transfer', () => {
    ensurePanelsInAppStore(
      WS,
      { t1: { id: 't1', type: 'terminal', title: 'zsh', isDirty: false, worktreeId: 'wt-b' } },
      '/repo',
      [WT_A, WT_B],
    )
    expect(ws()?.worktrees).toEqual([WT_A, WT_B])
  })

  it('backfills worktrees onto an existing stub with no panels (canvas children deferred)', () => {
    ensurePanelsInAppStore(WS, { c1: { id: 'c1', type: 'canvas', title: 'Canvas', isDirty: false } })
    expect(ws()?.worktrees).toEqual([])
    ensurePanelsInAppStore(WS, {}, undefined, [WT_A, WT_B])
    expect(ws()?.worktrees).toEqual([WT_A, WT_B])
  })

  it('merges by path so the carried color/id wins over an existing record', () => {
    ensurePanelsInAppStore(WS, {}, '/repo', [{ id: 'old', path: '/repo', color: '#000000' }])
    ensurePanelsInAppStore(WS, {}, undefined, [WT_A])
    const wts = ws()?.worktrees ?? []
    expect(wts).toHaveLength(1)
    expect(wts[0]).toEqual(WT_A)
  })

  it('leaves an existing registry untouched when the transfer carries none', () => {
    ensurePanelsInAppStore(WS, {}, '/repo', [WT_A])
    ensurePanelsInAppStore(WS, { t1: { id: 't1', type: 'terminal', title: 'zsh', isDirty: false } })
    expect(ws()?.worktrees).toEqual([WT_A])
  })
})

// Regression: creating a stub for workspace X must SELECT X, never keep a stale
// selectedWorkspaceId left by an earlier/bootstrapped workspace (the old `||`
// kept the stale id, keying the detached window off the wrong workspace).
describe('ensurePanelsInAppStore — stub selection', () => {
  it('selects the newly created stub even when selectedWorkspaceId is already set', () => {
    useAppStore.setState({ workspaces: [], selectedWorkspaceId: 'some-other-ws' })
    ensurePanelsInAppStore(WS, { a: { id: 'a', type: 'terminal', title: 'a', isDirty: false } })
    expect(useAppStore.getState().selectedWorkspaceId).toBe(WS)
  })

  it('initializes the stub with WorkspaceState defaults (empty worktrees, no extras)', () => {
    ensurePanelsInAppStore(WS, { a: { id: 'a', type: 'terminal', title: 'a', isDirty: false } })
    const ws = useAppStore.getState().workspaces.find((w) => w.id === WS)!
    expect(ws.worktrees).toEqual([])
    expect(ws.connection).toBeUndefined()
    expect(ws.runtime).toBeUndefined()
    expect(ws.additionalRoots).toBeUndefined()
    // The old stub leaked a non-WorkspaceState `focusedNodeId` field via `as any`.
    expect('focusedNodeId' in ws).toBe(false)
  })
})

describe('detached-window source of truth — live edits land + are captured', () => {
  it('active-tab URL updates on the stub workspace are captured without a mirror event', () => {
    // Init: populate appStore as the shell does on onDockWindowInit.
    ensurePanelsInAppStore(WS, {
      b1: browserPanel('https://start.test'),
    })

    // Live navigation: BrowserPanel writes straight into appStore.
    useAppStore.getState().updateBrowserActiveTabUrl(WS, 'b1', 'https://navigated.test')

    // What syncNow reads at call time reflects the edit.
    expect(browserPanelUrl(readPanels(WS).b1)).toBe('https://navigated.test')
  })

  it('setPanelDirty + updatePanelFilePath (Save-As) land without an editor:panel-saved-as mirror', () => {
    ensurePanelsInAppStore(WS, {
      e1: { id: 'e1', type: 'editor', title: 'Untitled', isDirty: true },
    })

    // EditorPanel Save-As path: it writes filePath + clears dirty directly.
    useAppStore.getState().updatePanelFilePath(WS, 'e1', '/repo/saved.ts')
    useAppStore.getState().setPanelDirty(WS, 'e1', false)

    const captured = readPanels(WS).e1
    expect(captured.filePath).toBe('/repo/saved.ts')
    expect(captured.isDirty).toBe(false)
  })
})

describe('removePanelRecord — clean record-only removal', () => {
  it('drops only the panels[panelId] entry, leaving others intact', () => {
    ensurePanelsInAppStore(WS, {
      a: { id: 'a', type: 'terminal', title: 'a', isDirty: false },
      b: { id: 'b', type: 'editor', title: 'b', isDirty: false },
    })
    useAppStore.getState().removePanelRecord(WS, 'a')
    expect(Object.keys(readPanels(WS))).toEqual(['b'])
  })

  it('no-ops for a missing panel / workspace', () => {
    ensurePanelsInAppStore(WS, { a: { id: 'a', type: 'terminal', title: 'a', isDirty: false } })
    useAppStore.getState().removePanelRecord(WS, 'nope')
    useAppStore.getState().removePanelRecord('other-ws', 'a')
    expect(Object.keys(readPanels(WS))).toEqual(['a'])
  })
})
