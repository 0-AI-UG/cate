// =============================================================================
// keepMountedPanels — which panel instances survive the canvas viewport cull.
//
// Extension panels must stay mounted off-screen: unmounting destroys the
// <webview> guest and its in-page state unrecoverably. Everything else is
// cullable.
//
// The second block covers the referential-stability contract: the keep-mounted
// set is the cache key of the cull's keep-alive memo, so it MUST keep its
// identity across unrelated store churn.
// =============================================================================

import React from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { PanelState } from '../../shared/types'
import { keepMountedOffscreenPanelIds, useKeepMountedPanelIds } from './keepMountedPanels'
import { useAppStore } from '../stores/appStore'
import { createCanvasStore, selectVisibleNodeIds } from '../stores/canvasStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const panel = (id: string, extensionId?: string): PanelState => ({
  id,
  type: extensionId ? 'extension' : 'editor',
  title: id,
  isDirty: false,
  ...(extensionId ? { extensionId, extensionPanelId: 'main' } : {}),
})

describe('keepMountedOffscreenPanelIds', () => {
  const panels: Record<string, PanelState> = {
    'p-editor': panel('p-editor'),
    'p-ext': panel('p-ext', 'acme.local'),
  }

  it('exempts extension panels', () => {
    expect(keepMountedOffscreenPanelIds(panels).has('p-ext')).toBe(true)
  })

  it('leaves non-webview panel types cullable', () => {
    expect(keepMountedOffscreenPanelIds(panels).has('p-editor')).toBe(false)
  })

  it('keeps a live Cate-owned coding-agent terminal mounted', () => {
    const runPanel: PanelState = {
      id: 'worker',
      type: 'terminal',
      title: 'Codex worker',
      isDirty: false,
      codingAgentRun: {
        id: 'run-1',
        agentId: 'codex',
        panelId: 'worker',
        ownerPanelId: 'agent-1',
        prompt: 'Implement it',
        createdAt: 1,
      },
    }
    expect(keepMountedOffscreenPanelIds({ worker: runPanel }).has('worker')).toBe(true)
    runPanel.codingAgentRun = { ...runPanel.codingAgentRun!, stoppedAt: 2 }
    expect(keepMountedOffscreenPanelIds({ worker: runPanel }).has('worker')).toBe(false)
    runPanel.codingAgentRun = {
      ...runPanel.codingAgentRun!,
      stoppedAt: undefined,
      endedAt: 3,
      exitCode: 0,
    }
    expect(keepMountedOffscreenPanelIds({ worker: runPanel }).has('worker')).toBe(false)
  })

  it('tolerates a workspace with no panels', () => {
    expect(keepMountedOffscreenPanelIds(undefined).size).toBe(0)
  })
})

// End-to-end through the actual cull core: an off-screen extension node survives
// while an off-screen editor node is culled.
describe('viewport cull with keep-mounted panels', () => {
  it('keeps the extension node and culls the editor node', () => {
    const store = createCanvasStore()
    const editorNode = store.getState().addNode('p-editor', 'editor', { x: 5000, y: 5000 }, { width: 100, height: 80 })
    const extNode = store.getState().addNode('p-ext', 'extension', { x: 5000, y: 6000 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })
    store.setState({ zoomLevel: 1, viewportOffset: { x: 0, y: 0 }, selection: [], selectionActive: false })

    const panels: Record<string, PanelState> = {
      'p-editor': panel('p-editor'),
      'p-ext': panel('p-ext', 'acme.local'),
    }
    const visible = selectVisibleNodeIds(store.getState(), keepMountedOffscreenPanelIds(panels))

    expect(visible).not.toContain(editorNode)
    expect(visible).toContain(extNode)
  })
})

// ---------------------------------------------------------------------------
// Referential stability — the cull's keep-alive cache is keyed on this set's
// identity, so unrelated store updates must NOT mint a new Set.
// ---------------------------------------------------------------------------
describe('useKeepMountedPanelIds — referential stability', () => {
  const wsId = 'ws-1'

  beforeEach(() => {
    useAppStore.setState({
      workspaces: [
        {
          ...(useAppStore.getState().workspaces[0] ?? {}),
          id: wsId,
          name: 'ws',
          rootPath: '/tmp/ws',
          panels: {
            'p-editor': panel('p-editor'),
            'p-ext': panel('p-ext', 'acme.local'),
          },
        },
      ] as never,
    })
  })

  it('returns the same Set object across unrelated panel churn and re-renders', () => {
    const seen: ReadonlySet<string>[] = []
    function Probe() {
      seen.push(useKeepMountedPanelIds(wsId))
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<Probe />)
    })

    expect([...seen[0]]).toEqual(['p-ext'])

    // Unrelated panel churn: a title edit swaps the panels record, re-running the
    // selector. Equal membership → zustand hands back the SAME object.
    act(() => {
      useAppStore.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === wsId
            ? { ...w, panels: { ...w.panels, 'p-ext': { ...w.panels['p-ext'], title: 'renamed' } } }
            : w,
        ),
      }))
    })
    // A forced re-render (new selector closure) must not mint a new set either.
    act(() => { root.render(<Probe />) })

    // Initial render + the forced one. (The title edit itself re-runs the
    // selector but produces an equal set, so it doesn't even re-render.)
    expect(seen.length).toBe(2)
    for (const s of seen) expect(s).toBe(seen[0])

    // A real membership change (a second extension panel) DOES produce a new set.
    act(() => {
      useAppStore.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === wsId ? { ...w, panels: { ...w.panels, 'p-ext2': panel('p-ext2', 'acme.local') } } : w,
        ),
      }))
    })
    const latest = seen[seen.length - 1]
    expect(latest).not.toBe(seen[0])
    expect([...latest].sort()).toEqual(['p-ext', 'p-ext2'])

    act(() => { root.unmount() })
    container.remove()
  })
})
