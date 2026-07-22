// @vitest-environment jsdom
// =============================================================================
// hydrateWorkspaceFromDiskIfEmpty — the runtime "load saved layout on open" path
// that fixes close-then-reopen coming up blank. These tests pin the guards (it
// must be a safe no-op unless the workspace is freshly opened and empty) and the
// happy path (an empty workspace with a saved .cate/ layout gets it restored).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

const projectStateLoad = vi.fn()

beforeEach(() => {
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    workspaceCreate: vi.fn(async (input: { id?: string; name?: string; rootPath?: string }) => ({
      ok: true,
      workspace: {
        id: input.id ?? 'gen',
        name: input.name ?? 'Workspace',
        color: '',
        rootPath: input.rootPath ?? '',
      },
    })),
    workspaceUpdate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceRemove: vi.fn(async () => ({ ok: true })),
    recentProjectsAdd: vi.fn(),
    recentProjectsRemove: vi.fn(async () => undefined),
    windowsCloseForWorkspace: vi.fn(async () => undefined),
    projectStateLoad,
  }
  projectStateLoad.mockReset()
})

import { useAppStore, awaitWorkspaceSync } from '../../stores/appStore'
import { hydrateWorkspaceFromDiskIfEmpty } from './session'
import { deferredSnapshots } from './deferredRestore'
import { useWorkspaceTrustStore } from '../../stores/workspaceTrustStore'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../../../shared/types'

const ROOT = '/repo'

function diskState(): { workspace: ProjectWorkspaceFile; session: ProjectSessionFile | null } {
  return {
    workspace: {
      version: 1,
      name: 'Saved',
      color: '',
      panels: { 'ed-1': { type: 'editor', title: 'file.ts', filePath: 'file.ts' } },
      canvases: {
        'cv-1': {
          id: 'cv-1',
          canvasNodes: {
            'node-ed-1': {
              id: 'node-ed-1',
              dockLayout: { type: 'tabs', id: 'stack-ed-1', panelIds: ['ed-1'], activeIndex: 0 },
              origin: { x: 0, y: 0 },
              size: { width: 200, height: 150 },
              zOrder: 0,
              creationIndex: 0,
            },
          },
          zoomLevel: 1,
          viewportOffset: { x: 0, y: 0 },
        },
      },
    },
    session: { version: 1, panels: {} },
  }
}

async function freshWorkspace(id: string, rootPath = ROOT): Promise<string> {
  const wsId = useAppStore.getState().addWorkspace('WS', rootPath, id)
  // Let the create's main-sync response settle so its applied WorkspaceInfo
  // can't later clobber the name hydrate restores from the .cate/ file.
  await awaitWorkspaceSync()
  return wsId
}

describe('hydrateWorkspaceFromDiskIfEmpty — guards', () => {
  beforeEach(() => {
    // Start each test from a clean workspace list.
    for (const w of [...useAppStore.getState().workspaces]) {
      deferredSnapshots.delete(w.id)
    }
  })

  it('no-ops when the workspace has no rootPath', async () => {
    const id = useAppStore.getState().addWorkspace('WS') // no rootPath
    await hydrateWorkspaceFromDiskIfEmpty(id)
    expect(projectStateLoad).not.toHaveBeenCalled()
  })

  it('no-ops when a deferred restore owns the workspace', async () => {
    const id = await freshWorkspace('ws-deferred')
    deferredSnapshots.set(id, { workspaceName: 'x', rootPath: ROOT } as never)
    await hydrateWorkspaceFromDiskIfEmpty(id)
    expect(projectStateLoad).not.toHaveBeenCalled()
    deferredSnapshots.delete(id)
  })

  it('no-ops when the disk has no saved layout', async () => {
    const id = await freshWorkspace('ws-nostate')
    projectStateLoad.mockResolvedValue(null)
    await hydrateWorkspaceFromDiskIfEmpty(id)
    expect(projectStateLoad).toHaveBeenCalledWith(ROOT)
    // Nothing restored — still no panels.
    const ws = useAppStore.getState().workspaces.find((w) => w.id === id)!
    expect(Object.keys(ws.panels)).toHaveLength(0)
  })
})

describe('hydrateWorkspaceFromDiskIfEmpty — restore', () => {
  it('loads the saved .cate/ layout into an empty workspace', async () => {
    const id = await freshWorkspace('ws-restore')
    projectStateLoad.mockResolvedValue(diskState())

    await hydrateWorkspaceFromDiskIfEmpty(id)

    expect(projectStateLoad).toHaveBeenCalledWith(ROOT)
    const ws = useAppStore.getState().workspaces.find((w) => w.id === id)!
    // The saved editor panel is now present, and the name synced from the file.
    expect(ws.panels['ed-1']).toBeDefined()
    expect(ws.panels['ed-1'].type).toBe('editor')
    expect(ws.name).toBe('Saved')
  })

  it('no-ops when the workspace already has real content', async () => {
    const id = await freshWorkspace('ws-has-content')
    projectStateLoad.mockResolvedValue(diskState())
    // First hydrate populates it...
    await hydrateWorkspaceFromDiskIfEmpty(id)
    projectStateLoad.mockClear()
    // ...a second hydrate must see live content and bail without reloading.
    await hydrateWorkspaceFromDiskIfEmpty(id)
    expect(projectStateLoad).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// GHSA-8769-jp52-985f — this is THE function that runs when a user opens a
// cloned repo, so it is where the trust boundary has to hold. The fixture is the
// advisory's proof-of-concept workspace.json.
// -----------------------------------------------------------------------------

/** The advisory PoC: an agent panel docked so that restoring it mounts pi,
 *  which loads the MCP adapter, which starts the repo's eager .pi/mcp.json. */
function hostileDiskState(): { workspace: ProjectWorkspaceFile; session: ProjectSessionFile | null } {
  return {
    workspace: {
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
    },
    session: { version: 1, panels: {} },
  } as unknown as { workspace: ProjectWorkspaceFile; session: ProjectSessionFile | null }
}

describe('hydrateWorkspaceFromDiskIfEmpty — workspace trust', () => {
  beforeEach(() => {
    useWorkspaceTrustStore.setState({ trusted: [], hydrated: true, withheld: {}, pendingByLocator: {} })
  })

  it('does not restore a repo-supplied agent panel from an untrusted project', async () => {
    const id = await freshWorkspace('ws-hostile', '/hostile')
    projectStateLoad.mockResolvedValue(hostileDiskState())

    await hydrateWorkspaceFromDiskIfEmpty(id)

    // No panel record ⇒ AgentPanel never mounts ⇒ pi never starts ⇒ the MCP
    // adapter never reads .pi/mcp.json. The chain is cut at the first link.
    const ws = useAppStore.getState().workspaces.find((w) => w.id === id)!
    expect(ws.panels['agent-poc']).toBeUndefined()
    expect(Object.values(ws.panels).some((p) => p.type === 'agent')).toBe(false)
  })

  it('records a banner notice naming the withheld agent panel', async () => {
    const id = await freshWorkspace('ws-hostile-notice', '/hostile2')
    projectStateLoad.mockResolvedValue(hostileDiskState())

    await hydrateWorkspaceFromDiskIfEmpty(id)

    expect(useWorkspaceTrustStore.getState().withheld[id]?.summary.byType.agent).toBe(1)
  })

  it('restores the same layout once the user trusts the project', async () => {
    const id = await freshWorkspace('ws-trusted', '/trusted-repo')
    useWorkspaceTrustStore.setState({
      trusted: ['/trusted-repo'], hydrated: true, withheld: {}, pendingByLocator: {},
    })
    projectStateLoad.mockResolvedValue(hostileDiskState())

    await hydrateWorkspaceFromDiskIfEmpty(id)

    // Trust is the ONLY thing that changed between this and the first test.
    const ws = useAppStore.getState().workspaces.find((w) => w.id === id)!
    expect(ws.panels['agent-poc']).toBeDefined()
    expect(ws.panels['agent-poc'].type).toBe('agent')
    expect(useWorkspaceTrustStore.getState().withheld[id]).toBeUndefined()
  })
})
