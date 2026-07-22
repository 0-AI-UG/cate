// @vitest-environment jsdom
// =============================================================================
// Autosave must never write into an untrusted project.
//
// Found the hard way: with the trust gate in place but autosave unguarded,
// opening an untrusted repo restored a PARTIAL layout (process-bearing panels
// withheld) and then autosave wrote that partial layout straight back over
// `.cate/workspace.json` — permanently deleting the withheld panels from the
// user's own file. "Trust and restore" would then restore nothing, because
// there was nothing left to restore.
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
  useWorkspaceTrustStore.setState({ trusted: [], hydrated: true, withheld: {}, pendingByLocator: {} })
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
    useWorkspaceTrustStore.setState({ trusted: [ROOT], hydrated: true, withheld: {}, pendingByLocator: {} })

    await saveSession()

    expect(savesForRoot()).toHaveLength(1)
  })

  it('stays blocked after the trust prompt is dismissed', async () => {
    // Dismissing clears the withheld notice but grants nothing. If the guard
    // keyed off that notice instead of trust, autosave would resume here and
    // clobber the file a moment later — the exact bug this pins.
    useWorkspaceTrustStore.getState().noteWithheld('ws-1', ROOT, { byType: { agent: 1 }, total: 1 })
    useWorkspaceTrustStore.getState().clearWithheld('ws-1')

    await saveSession()

    expect(savesForRoot()).toHaveLength(0)
  })
})
