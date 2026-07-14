// @vitest-environment jsdom
// =============================================================================
// Tests for workspaceIdAtOffset — the pure next/previous-workspace resolver
// backing the customizable workspace-switch shortcut (issue #456). Ordering
// follows the `workspaces` array (same order the sidebar renders), and stepping
// wraps around both ends.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorkspaceState } from '../../../shared/types'

vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    setPendingRestore: vi.fn(),
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

import { workspaceIdAtOffset } from './workspaceSlice'
import { useAppStore } from '../appStore'

const ws = (id: string) => ({ id })

/** A minimal already-activated local workspace: has a rootPath (so it isn't
 *  swept as an uninitialized row) and a non-canvas panel (so selectWorkspace
 *  skips the from-disk hydration path). */
function localWorkspace(id: string): WorkspaceState {
  return {
    id,
    name: id,
    color: '',
    rootPath: `/tmp/${id}`,
    panels: { [`t-${id}`]: { id: `t-${id}`, type: 'terminal', title: 'Terminal', isDirty: false } },
  } as WorkspaceState
}

describe('switchWorkspaceByOffset (store action)', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [localWorkspace('a'), localWorkspace('b'), localWorkspace('c')],
      selectedWorkspaceId: 'a',
    })
  })

  it('switches to the next workspace', async () => {
    await useAppStore.getState().switchWorkspaceByOffset(1)
    expect(useAppStore.getState().selectedWorkspaceId).toBe('b')
  })

  it('switches to the previous workspace, wrapping to the last', async () => {
    await useAppStore.getState().switchWorkspaceByOffset(-1)
    expect(useAppStore.getState().selectedWorkspaceId).toBe('c')
  })

  it('is a no-op with a single workspace', async () => {
    useAppStore.setState({ workspaces: [localWorkspace('solo')], selectedWorkspaceId: 'solo' })
    await useAppStore.getState().switchWorkspaceByOffset(1)
    expect(useAppStore.getState().selectedWorkspaceId).toBe('solo')
  })
})

describe('workspaceIdAtOffset', () => {
  const three = [ws('a'), ws('b'), ws('c')]

  it('steps forward to the next workspace', () => {
    expect(workspaceIdAtOffset(three, 'a', 1)).toBe('b')
    expect(workspaceIdAtOffset(three, 'b', 1)).toBe('c')
  })

  it('steps backward to the previous workspace', () => {
    expect(workspaceIdAtOffset(three, 'c', -1)).toBe('b')
    expect(workspaceIdAtOffset(three, 'b', -1)).toBe('a')
  })

  it('wraps forward from the last workspace to the first', () => {
    expect(workspaceIdAtOffset(three, 'c', 1)).toBe('a')
  })

  it('wraps backward from the first workspace to the last', () => {
    expect(workspaceIdAtOffset(three, 'a', -1)).toBe('c')
  })

  it('returns null when there are fewer than two workspaces', () => {
    expect(workspaceIdAtOffset([ws('only')], 'only', 1)).toBeNull()
    expect(workspaceIdAtOffset([], 'missing', 1)).toBeNull()
  })

  it('returns null when the current workspace is not in the list', () => {
    expect(workspaceIdAtOffset(three, 'z', 1)).toBeNull()
  })
})
