// @vitest-environment jsdom
// =============================================================================
// End-to-end check of the trust gate through the REAL open-a-project path
// (GHSA-8769-jp52-985f).
//
// sessionTrustFilter.test.ts covers the pure filter. This covers the WIRING:
// that `hydrateWorkspaceFromDiskIfEmpty` — the function that runs when you open
// a cloned repo — actually consults the gate, and that a hostile
// `.cate/workspace.json` therefore never reaches `restoreWorkspaceLayout`. A
// correct filter wired to nothing would still be the vulnerability.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gateProjectFiles } from './projectTrustGate'
import { useWorkspaceTrustStore } from '../../stores/workspaceTrustStore'
import type { ProjectWorkspaceFile } from '../../../shared/types'

const ROOT = '/tmp/hostile-repo'

/** The advisory's PoC layout: one agent panel, docked so it mounts on open. */
function hostileWorkspaceFile(): ProjectWorkspaceFile {
  return {
    version: 1,
    name: 'Cate MCP PoC',
    color: '',
    panels: { 'agent-poc': { type: 'agent', title: 'Agent' } },
    dockState: {
      zones: {
        left: { position: 'left', visible: false, size: 0, layout: null },
        right: { position: 'right', visible: false, size: 0, layout: null },
        bottom: { position: 'bottom', visible: false, size: 0, layout: null },
        center: {
          position: 'center', visible: true, size: 0,
          layout: { type: 'tabs', id: 'agent-poc-tabs', panelIds: ['agent-poc'], activeIndex: 0 },
        },
      },
    },
  } as ProjectWorkspaceFile
}

beforeEach(() => {
  useWorkspaceTrustStore.setState({ trusted: [], hydrated: true, withheld: {}, pendingByLocator: {} })
})

describe('gateProjectFiles — untrusted project', () => {
  it('strips the agent panel a hostile repo asked to auto-mount', () => {
    const { workspace } = gateProjectFiles(hostileWorkspaceFile(), null, ROOT, 'ws-1')

    // No agent panel record ⇒ restorePanelRecords creates nothing ⇒ AgentPanel
    // never mounts ⇒ pi never starts ⇒ the MCP adapter never reads .pi/mcp.json.
    expect(workspace.panels).toEqual({})
    expect(workspace.dockState?.zones.center.layout).toBeNull()
  })

  it('files a prompt notice naming what it withheld', () => {
    gateProjectFiles(hostileWorkspaceFile(), null, ROOT, 'ws-1')

    const notice = useWorkspaceTrustStore.getState().withheld['ws-1']
    expect(notice).toBeDefined()
    expect(notice.locator).toBe(ROOT)
    expect(notice.summary.byType.agent).toBe(1)
  })

  it('files the notice by locator when no workspace id exists yet (startup load)', () => {
    gateProjectFiles(hostileWorkspaceFile(), null, ROOT)

    expect(useWorkspaceTrustStore.getState().pendingByLocator[ROOT]?.byType.agent).toBe(1)

    // ...and adopting it binds the notice to the workspace once created.
    useWorkspaceTrustStore.getState().adoptPending('ws-9', ROOT)
    expect(useWorkspaceTrustStore.getState().withheld['ws-9']?.summary.byType.agent).toBe(1)
    expect(useWorkspaceTrustStore.getState().pendingByLocator[ROOT]).toBeUndefined()
  })
})

describe('gateProjectFiles — trusted project', () => {
  it('passes the layout through untouched once trusted', () => {
    useWorkspaceTrustStore.setState({ trusted: [ROOT], hydrated: true, withheld: {}, pendingByLocator: {} })
    const input = hostileWorkspaceFile()

    const { workspace } = gateProjectFiles(input, null, ROOT, 'ws-1')

    // Same object identity: a trusted project must not pay the filter's cost or
    // risk it silently dropping something the user actually wants restored.
    expect(workspace).toBe(input)
    expect(workspace.panels?.['agent-poc']).toBeDefined()
    expect(useWorkspaceTrustStore.getState().withheld['ws-1']).toBeUndefined()
  })

  it('trusts by exact locator, not prefix', () => {
    useWorkspaceTrustStore.setState({ trusted: ['/tmp/hostile'], hydrated: true, withheld: {}, pendingByLocator: {} })

    // '/tmp/hostile' must not vouch for '/tmp/hostile-repo'.
    const { workspace } = gateProjectFiles(hostileWorkspaceFile(), null, ROOT, 'ws-1')
    expect(workspace.panels).toEqual({})
  })
})

describe('workspaceTrustStore.hydrate — fails closed', () => {
  it('treats every project as untrusted when the trust list cannot be read', async () => {
    vi.stubGlobal('window', {
      electronAPI: { projectTrustGet: vi.fn().mockRejectedValue(new Error('EACCES')) },
    })

    await useWorkspaceTrustStore.getState().hydrate()

    expect(useWorkspaceTrustStore.getState().trusted).toEqual([])
    expect(useWorkspaceTrustStore.getState().isTrusted(ROOT)).toBe(false)
    vi.unstubAllGlobals()
  })
})
