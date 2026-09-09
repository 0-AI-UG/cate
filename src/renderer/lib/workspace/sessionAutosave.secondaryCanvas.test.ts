// @vitest-environment jsdom
// =============================================================================
// Autosave must watch EVERY canvas of the active workspace, not just the primary.
// A geometry edit (pan/zoom/move/resize) on a SECONDARY canvas has to mark the
// session dirty + schedule a save — otherwise the quit flush ACKs without
// writing and the last up-to-30s of edits on that canvas are silently lost.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

// Stub the actual save so we test SCHEDULING, not the full serialize pipeline.
const saveSession = vi.fn(async () => {})
vi.mock('./sessionSave', () => ({ saveSession: () => saveSession() }))

import { useAppStore } from '../../stores/appStore'
import { useUIStore } from '../../stores/uiStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { editorDocument, releaseEditorPanel } from '../editor/editorDocuments'
import { setupAutoSave } from './sessionAutosave'
import type { PanelState } from '../../../shared/types'

// Mirrors MAX_WAIT in sessionAutosave.ts — long enough to flush the debounced
// save, short enough to stay under the 30s unconditional periodic save.
const MAX_WAIT = 4000

const PRIMARY = 'canvas-primary'
const SECONDARY = 'canvas-secondary'

function canvasPanel(id: string): PanelState {
  return { id, type: 'canvas', title: 'Canvas', isDirty: false }
}

let flushCallback: (() => void) | null = null
let teardown: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  saveSession.mockReset()
  saveSession.mockImplementation(async () => {})
  flushCallback = null

  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    onSessionFlushSave: vi.fn((cb: () => void) => {
      flushCallback = cb
      return () => { flushCallback = null }
    }),
    sessionFlushSaveDone: vi.fn(),
  }

  // A workspace with a primary AND a secondary canvas panel, both mounted.
  useAppStore.setState({
    workspaces: [
      {
        id: 'ws-1',
        name: 'WS',
        color: '',
        rootPath: '/repo',
        panels: { [PRIMARY]: canvasPanel(PRIMARY), [SECONDARY]: canvasPanel(SECONDARY) },
      },
    ],
    selectedWorkspaceId: 'ws-1',
  } as never)
  useUIStore.setState({
    sourceControlWorktreeByRepository: {},
  })
  getOrCreateCanvasStoreForPanel(PRIMARY)
  getOrCreateCanvasStoreForPanel(SECONDARY)
})

afterEach(() => {
  teardown?.()
  teardown = null
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(SECONDARY)
  vi.useRealTimers()
})

describe('autosave watches secondary canvases', () => {
  it('schedules a save when a SECONDARY canvas is panned', async () => {
    teardown = setupAutoSave()
    // Setup arms no save on its own, so the spy starts clean.
    expect(saveSession).not.toHaveBeenCalled()

    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setViewportOffset({ x: 42, y: 7 })

    // Advance only past the debounce window — staying well under the 30s
    // unconditional periodic save, so the only thing that can fire a save is the
    // canvas subscription scheduled by the edit above.
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).toHaveBeenCalled()
  })

  it('quit flush WRITES (does not skip-ACK) after a secondary-canvas edit', async () => {
    teardown = setupAutoSave()

    // Even an unchanged renderer recaptures freshly flushed detached owners.
    flushCallback!()
    await vi.advanceTimersByTimeAsync(0)
    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.sessionFlushSaveDone).toHaveBeenCalledTimes(1)

    // A geometry edit on the secondary canvas marks the session dirty.
    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setZoom(2)

    flushCallback!()
    await Promise.resolve()
    expect(saveSession).toHaveBeenCalled()
  })

  it('subscribes a secondary canvas created AFTER setup', async () => {
    // Start with only the primary mounted; drop the secondary store.
    releaseCanvasStoreForPanel(SECONDARY)
    teardown = setupAutoSave()

    // Mount the secondary canvas later — an appStore change re-runs subscribeActive
    // and picks up the freshly-mounted secondary store.
    getOrCreateCanvasStoreForPanel(SECONDARY)
    useAppStore.setState((s) => ({ workspaces: [...s.workspaces] }) as never)
    // Drain the save the appStore change armed, then start clean.
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    saveSession.mockClear()

    // Editing the just-mounted secondary canvas must schedule a save.
    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setViewportOffset({ x: 1, y: 2 })

    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).toHaveBeenCalled()
  })

  it('saves worktree view scope changes but ignores transient UI state', async () => {
    teardown = setupAutoSave()

    useUIStore.getState().setHoveredWorktree('wt-1')
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).not.toHaveBeenCalled()

    useUIStore.getState().setSourceControlWorktree('/repo', 'wt-2')
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).toHaveBeenCalledTimes(1)
  })
  it('flushes edits made after an already-dirty document was autosaved', async () => {
    const panel: PanelState = { id: 'scratch-revision', type: 'editor', title: 'Untitled', isDirty: false }
    useAppStore.setState(state => ({ workspaces: state.workspaces.map(ws => ({ ...ws, panels: { ...ws.panels, [panel.id]: panel } })) }))
    const document = editorDocument('ws-1', panel.id)
    let value = 'A'
    const detach = document.attach({ getModel: () => ({ getValue: () => value, setValue: next => { value = next }, isDisposed: () => false }) })
    teardown = setupAutoSave()
    document.noteUserEdit()
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    saveSession.mockClear()
    value = 'B'
    document.noteUserEdit()
    flushCallback!()
    await vi.advanceTimersByTimeAsync(0)
    expect(saveSession).toHaveBeenCalledTimes(1)
    detach()
    releaseEditorPanel(panel.id)
  })

  it('does not acknowledge quit until edits during the in-flight flush are durable', async () => {
    const releases: (() => void)[] = []
    saveSession.mockImplementation(() => new Promise<void>(resolve => releases.push(resolve)))
    teardown = setupAutoSave()
    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setZoom(2)
    flushCallback!()
    await vi.advanceTimersByTimeAsync(0)
    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setZoom(3)
    releases[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.electronAPI.sessionFlushSaveDone).not.toHaveBeenCalled()
    expect(releases).toHaveLength(2)
    releases[1]()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.electronAPI.sessionFlushSaveDone).toHaveBeenCalledTimes(1)
    saveSession.mockImplementation(async () => {})
  })

  it('reports failed durability to quit and retries on a later flush', async () => {
    saveSession.mockRejectedValueOnce(new Error('disk unavailable'))
    teardown = setupAutoSave()
    getOrCreateCanvasStoreForPanel(SECONDARY).getState().setZoom(2)
    flushCallback!()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.electronAPI.sessionFlushSaveDone).toHaveBeenCalledWith('disk unavailable', undefined)
    flushCallback!()
    await vi.advanceTimersByTimeAsync(0)
    expect(saveSession).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.sessionFlushSaveDone).toHaveBeenLastCalledWith(undefined, undefined)
  })

})
