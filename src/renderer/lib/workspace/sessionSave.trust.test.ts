// @vitest-environment jsdom
// =============================================================================
// Autosave must never write into an untrusted project.
//
// The gate is on the open path, so an open workspace is a trusted one and this
// guard should never fire in practice. It is the backstop for the one way that
// invariant can break — trust revoked under a live workspace — where autosave
// would otherwise keep rewriting `.cate/` files in a project the user has just
// said they don't trust.
//
// The rule is flat: untrusted project ⇒ no project-state write at all.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { useAppStore } from '../../stores/appStore'
import { useWorkspaceTrustStore } from '../../stores/workspaceTrustStore'
import { saveSession } from './sessionSave'
import type { PanelState } from '../../../shared/types'

function terminalPanel(id: string): PanelState {
  return { id, type: 'terminal', title: id, isDirty: false }
}

let projectStateSave: ReturnType<typeof vi.fn>
// Fresh root per test: `lastSerializedByRoot` in sessionSave is module-level and
// would otherwise dedup away a write an earlier test already made.
let rootSeq = 0
let ROOT = ''

beforeEach(() => {
  ROOT = `/tmp/trust-save-${rootSeq++}`
  projectStateSave = vi.fn(async () => {})
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    projectStateSave,
    dockWindowsList: vi.fn(async () => []),
    remoteProjectsSet: vi.fn(async () => {}),
    sidebarSessionSet: vi.fn(async () => {}),
    terminalGetCwd: vi.fn(async () => null),
  }
  useAppStore.setState({
    workspaces: [
      { id: 'ws-1', name: 'WS', color: '', rootPath: ROOT, panels: { p1: terminalPanel('p1') } },
    ],
    selectedWorkspaceId: 'ws-1',
  } as never)
  useWorkspaceTrustStore.setState({ trusted: [], hydrated: true, queue: [] })
})

function savesForRoot(): unknown[][] {
  return projectStateSave.mock.calls.filter((c) => c[0] === ROOT)
}

describe('autosave and workspace trust', () => {
  it('does not write .cate/ files for an untrusted project', async () => {
    await saveSession()
    expect(savesForRoot()).toHaveLength(0)
  })

  it('writes normally once the project is trusted', async () => {
    useWorkspaceTrustStore.setState({ trusted: [ROOT], hydrated: true, queue: [] })

    await saveSession()

    expect(savesForRoot()).toHaveLength(1)
  })

  it('stops writing when trust is revoked under a live workspace', async () => {
    useWorkspaceTrustStore.setState({ trusted: [ROOT], hydrated: true, queue: [] })
    await saveSession()
    expect(savesForRoot()).toHaveLength(1)

    // Revoked. The workspace is still on screen, but its files are off limits.
    useWorkspaceTrustStore.setState({ trusted: [], hydrated: true, queue: [] })
    useAppStore.setState({
      workspaces: [
        { id: 'ws-1', name: 'WS2', color: '', rootPath: ROOT, panels: { p1: terminalPanel('p1') } },
      ],
    } as never)

    await saveSession()

    expect(savesForRoot()).toHaveLength(1)
  })
})
