// @vitest-environment jsdom
// =============================================================================
// restoreDetachedWindows — the startup driver that fans a session's persisted
// dockWindows out to main. For each snapshot it runs the REAL reconstruction
// (buildDockWindowRestoreInit), resolves the owning workspace's live
// rootPath/worktrees from the app store, and calls
// window.electronAPI.dockWindowRestore. These tests pin the orchestration:
// which snapshots reach the IPC, with what payload, and that one degenerate or
// failing window can never abort the rest of startup.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  DetachedDockWindowSnapshot,
  MultiWorkspaceSession,
  PanelState,
  WindowDockState,
  WorktreeMeta,
} from '../../../shared/types'

const hoisted = vi.hoisted(() => ({
  // Live workspaces visible to sessionStartup via the mocked app store.
  workspaces: [] as Array<{ id: string; rootPath?: string; worktrees?: WorktreeMeta[] }>,
  warn: vi.fn(),
}))

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: hoisted.warn, error: vi.fn(), log: vi.fn() },
}))
// Only .getState().workspaces is consulted on this path; the real store's
// import chain (IPC sync, terminals, canvases) stays out of the test.
vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: hoisted.workspaces }) },
}))
// Imported by sessionStartup for the multi-workspace restore path (not under
// test here); mocked to cut its heavy store/terminal import chain.
vi.mock('./sessionRestore', () => ({ restoreWorkspaceLayout: vi.fn() }))

import { restoreDetachedWindows, buildDockWindowRestoreInit } from './sessionStartup'

const dockWindowRestore = vi.fn<(payload: unknown) => Promise<number | null>>()

beforeEach(() => {
  hoisted.workspaces.length = 0
  hoisted.warn.mockClear()
  dockWindowRestore.mockReset()
  dockWindowRestore.mockResolvedValue(301)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { dockWindowRestore }
})

const emptyZone = (position: 'left' | 'right' | 'bottom' | 'center') =>
  ({ position, visible: false, size: 0, layout: null })

function zonesWith(panelIds: string[]): WindowDockState {
  return {
    left: emptyZone('left'),
    right: emptyZone('right'),
    bottom: emptyZone('bottom'),
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: { type: 'tabs', id: 'stack-1', panelIds, activeIndex: 0 },
    },
  }
}

const panel = (id: string): PanelState =>
  ({ id, type: 'terminal', title: `Terminal ${id}`, isDirty: false }) as PanelState

function snapshot(panelIds: string[], overrides?: Partial<DetachedDockWindowSnapshot>): DetachedDockWindowSnapshot {
  return {
    dockState: { zones: zonesWith(panelIds) },
    panels: Object.fromEntries(panelIds.map((id) => [id, panel(id)])),
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    workspaceId: 'ws-9',
    canvasStates: {},
    ...overrides,
  }
}

/** A window whose zones reference nothing — nothing restorable to show. */
function emptySnapshot(): DetachedDockWindowSnapshot {
  const dw = snapshot([])
  dw.dockState.zones.center.layout = null
  // An orphan record with no zone reference must not resurrect the window.
  dw.panels = { orphan: panel('orphan') }
  return dw
}

const session = (dockWindows?: DetachedDockWindowSnapshot[]): MultiWorkspaceSession =>
  ({ version: 2, selectedWorkspaceIndex: 0, workspaces: [], dockWindows })

describe('restoreDetachedWindows', () => {
  it('restores each restorable snapshot once, skipping windows with no top-level panels', async () => {
    const worktrees = [{ id: 'wt-1', path: '/live/root/.wt/feature', color: '#f00' } as unknown as WorktreeMeta]
    hoisted.workspaces.push({ id: 'ws-9', rootPath: '/live/root', worktrees })
    const valid = snapshot(['t1'], { terminalCwds: { t1: '/work/t1' } })

    await restoreDetachedWindows(session([valid, emptySnapshot()]))

    // The degenerate window never reaches the IPC; the valid one goes out with
    // the snapshot verbatim plus the reconstructed initPayload, its
    // rootPath/worktrees swapped for the LIVE workspace's values.
    expect(dockWindowRestore).toHaveBeenCalledTimes(1)
    expect(dockWindowRestore).toHaveBeenCalledWith({
      ...valid,
      initPayload: {
        ...buildDockWindowRestoreInit(valid).initPayload,
        rootPath: '/live/root',
        worktrees,
      },
    })
  })

  it('leaves rootPath/worktrees unresolved when the owning workspace is not open', async () => {
    await restoreDetachedWindows(session([snapshot(['t1'])]))

    expect(dockWindowRestore).toHaveBeenCalledTimes(1)
    const payload = dockWindowRestore.mock.calls[0][0] as { initPayload: { rootPath?: string; worktrees?: unknown } }
    expect(payload.initPayload.rootPath).toBeUndefined()
    expect(payload.initPayload.worktrees).toBeUndefined()
  })

  it('does nothing for a session with no dock windows', async () => {
    await restoreDetachedWindows(session(undefined))
    await restoreDetachedWindows(session([]))
    expect(dockWindowRestore).not.toHaveBeenCalled()
  })

  it('tolerates main declining a restore (null) and continues with the rest', async () => {
    dockWindowRestore.mockResolvedValueOnce(null)

    await expect(
      restoreDetachedWindows(session([snapshot(['a1']), snapshot(['b1'])])),
    ).resolves.toBeUndefined()

    expect(dockWindowRestore).toHaveBeenCalledTimes(2)
    expect(hoisted.warn).not.toHaveBeenCalled()
  })

  it('isolates one snapshot\'s failure so the remaining windows still restore', async () => {
    dockWindowRestore.mockRejectedValueOnce(new Error('ipc exploded'))

    await restoreDetachedWindows(session([snapshot(['a1']), snapshot(['b1'])]))

    expect(dockWindowRestore).toHaveBeenCalledTimes(2)
    const second = dockWindowRestore.mock.calls[1][0] as DetachedDockWindowSnapshot
    expect(Object.keys(second.panels)).toEqual(['b1'])
    expect(hoisted.warn).toHaveBeenCalledTimes(1)
  })

  it('still issues the IPC for a ghost-first snapshot (main declines it with null)', async () => {
    // Pins current behavior: buildDockWindowRestoreInit does NOT prune zone ids
    // whose panel record is gone (see the `.fails` pin in
    // session.restoreDockWindow.test.ts), so a stale layout whose FIRST tab is a
    // ghost still goes out over IPC. Main's DOCK_WINDOW_RESTORE then bails null
    // (first panel record missing) and this driver tolerates that, so the net
    // effect is a wasted round-trip and a silently dropped window.
    const ghostFirst = snapshot(['ghost', 't1'])
    delete ghostFirst.panels.ghost
    dockWindowRestore.mockResolvedValueOnce(null)

    await restoreDetachedWindows(session([ghostFirst, snapshot(['b1'])]))

    expect(dockWindowRestore).toHaveBeenCalledTimes(2)
    expect(hoisted.warn).not.toHaveBeenCalled()
  })
})
