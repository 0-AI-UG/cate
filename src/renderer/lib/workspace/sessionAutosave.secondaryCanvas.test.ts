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
  saveSession.mockClear()
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
    navigationWorktreeByWorkspace: {},
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

    // First flush with no edits skips the round-trip entirely.
    flushCallback!()
    expect(saveSession).not.toHaveBeenCalled()
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

    useUIStore.getState().setNavigationWorktree('ws-1', 'wt-1')
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).toHaveBeenCalledTimes(1)

    saveSession.mockClear()
    useUIStore.getState().setSourceControlWorktree('/repo', 'wt-2')
    await vi.advanceTimersByTimeAsync(MAX_WAIT)
    expect(saveSession).toHaveBeenCalledTimes(1)
  })
})
