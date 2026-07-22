// @vitest-environment jsdom
// =============================================================================
// Per-root write ownership: when two workspaces share one rootPath (a duplicated
// workspace), exactly ONE — the owner — writes .cate/workspace.json per save.
// Otherwise the rootPath-keyed dedup never settles, the file flip-flops every
// autosave tick, and one layout is lost on restart. The SELECTED workspace owns
// the write so the active layout is what persists.
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
// A fresh rootPath per test sidesteps the module-level `lastSerializedByRoot`
// dedup, which persists across tests and would otherwise suppress a write of an
// identical payload a previous test already made.
let rootSeq = 0
let ROOT = ''

beforeEach(() => {
  ROOT = `/tmp/dup-root-${rootSeq++}`
  // Untrusted projects are never written to (see sessionSave), so this
  // ownership test has to trust its root to exercise the write path at all.
  useWorkspaceTrustStore.setState({ trusted: [ROOT], hydrated: true, withheld: {}, pendingByLocator: {} })
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

  // Two workspaces on ONE rootPath, each with its own (distinct) panel so their
  // serialized payloads differ — exactly the duplicate-workspace situation.
  useAppStore.setState({
    workspaces: [
      { id: 'ws-owner', name: 'Owner', color: '', rootPath: ROOT, panels: { 'p-owner': terminalPanel('p-owner') } },
      { id: 'ws-other', name: 'Other', color: '', rootPath: ROOT, panels: { 'p-other': terminalPanel('p-other') } },
    ],
    selectedWorkspaceId: 'ws-owner',
  } as never)
})

function savesForRoot(): unknown[][] {
  return projectStateSave.mock.calls.filter((c) => c[0] === ROOT)
}

describe('per-root write ownership', () => {
  it('writes the shared root exactly once per save (no double write)', async () => {
    await saveSession()
    expect(savesForRoot()).toHaveLength(1)
  })

  it('the SELECTED workspace owns the write', async () => {
    await saveSession()
    const [, wsFile] = savesForRoot()[0] as [string, { name?: string }]
    // The selected workspace's own data (its name) is what landed on disk, not
    // the other tab's — so the active layout wins, deterministically.
    expect(wsFile.name).toBe('Owner')
  })

  it('the owner follows the selection — selecting the other tab makes IT the owner', async () => {
    useAppStore.setState({ selectedWorkspaceId: 'ws-other' } as never)
    await saveSession()
    const [, wsFile] = savesForRoot()[0] as [string, { name?: string }]
    expect(wsFile.name).toBe('Other')
  })

  it('ownership is stable across consecutive saves — the file does not flip-flop', async () => {
    await saveSession()
    // Let the projectStateSave promise (and its dedup-setting .then) settle.
    await Promise.resolve()
    await Promise.resolve()
    const firstCount = savesForRoot().length
    expect(firstCount).toBe(1)

    // A second save with no changes must NOT rewrite the root: the same owner
    // serializes the same payload both times, so the dedup settles instead of
    // two workspaces alternating writes (the flip-flop).
    await saveSession()
    expect(savesForRoot()).toHaveLength(firstCount)
  })
})
