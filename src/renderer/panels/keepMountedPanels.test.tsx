// =============================================================================
// keepMountedPanels — which panel instances survive the canvas viewport cull.
//
// Local (frontend/server) extensions must stay mounted off-screen: unmounting
// destroys the <webview> guest and its in-page state unrecoverably. url-mode
// extensions are remote SaaS pages whose login lives in the persistent
// `persist:ext-<id>` session partition, so a remount just reloads the page —
// they participate in the cull like any other node.
//
// The second block covers the referential-stability contract: the keep-mounted
// set is the cache key of the cull's keep-alive memo, so it MUST keep its
// identity across unrelated store churn.
// =============================================================================

import React from 'react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ExtensionListEntry } from '../../shared/extensions'
import type { PanelState } from '../../shared/types'
import {
  urlModeExtensionIds,
  keepMountedOffscreenPanelIds,
  useKeepMountedPanelIds,
} from './keepMountedPanels'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useAppStore } from '../stores/appStore'
import { createCanvasStore, selectVisibleNodeIds } from '../stores/canvasStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entry = (id: string, extra: Partial<ExtensionListEntry['manifest']>): ExtensionListEntry => ({
  manifest: { id, name: id, panels: [{ id: 'main', label: 'Main' }], ...extra },
  enabled: true,
  source: 'catalog',
  rootDir: `/ext/${id}`,
  installed: true,
})

const panel = (id: string, extensionId?: string): PanelState => ({
  id,
  type: extensionId ? 'extension' : 'editor',
  title: id,
  isDirty: false,
  ...(extensionId ? { extensionId, extensionPanelId: 'main' } : {}),
})

describe('urlModeExtensionIds', () => {
  it('picks manifests with a url and no server (server > url precedence)', () => {
    const ids = urlModeExtensionIds([
      entry('acme.remote', { url: 'https://jira.example.com' }),
      entry('acme.local', { frontend: 'index.html' }),
      entry('acme.served', { server: { command: 'node s.js' } }),
      // A mixed manifest resolves as server mode, so it is NOT url mode.
      entry('acme.mixed', { url: 'https://x.example.com', server: { command: 'node s.js' } }),
    ])
    expect([...ids]).toEqual(['acme.remote'])
  })
})

describe('keepMountedOffscreenPanelIds', () => {
  const panels: Record<string, PanelState> = {
    'p-editor': panel('p-editor'),
    'p-url': panel('p-url', 'acme.remote'),
    'p-local': panel('p-local', 'acme.local'),
    'p-unknown': panel('p-unknown', 'acme.notyetloaded'),
  }
  const urlMode = new Set(['acme.remote'])

  it('exempts local extensions but not url-mode ones', () => {
    const ids = keepMountedOffscreenPanelIds(panels, urlMode)
    expect(ids.has('p-local')).toBe(true)
    expect(ids.has('p-url')).toBe(false)
  })

  it('exempts an extension whose manifest is not loaded yet (safe default)', () => {
    expect(keepMountedOffscreenPanelIds(panels, urlMode).has('p-unknown')).toBe(true)
    // Registry not loaded at all → every extension panel stays mounted.
    expect(keepMountedOffscreenPanelIds(panels, new Set()).has('p-url')).toBe(true)
  })

  it('leaves non-webview panel types cullable', () => {
    expect(keepMountedOffscreenPanelIds(panels, urlMode).has('p-editor')).toBe(false)
  })
})

// End-to-end through the actual cull core: an off-screen node hosting a url-mode
// extension is unmounted, a local one is not.
describe('viewport cull with url-mode extensions', () => {
  it('culls the url-mode extension node and keeps the local one', () => {
    const store = createCanvasStore()
    const urlNode = store.getState().addNode('p-url', 'extension', { x: 5000, y: 5000 }, { width: 100, height: 80 })
    const localNode = store.getState().addNode('p-local', 'extension', { x: 5000, y: 6000 }, { width: 100, height: 80 })
    store.getState().setContainerSize({ width: 800, height: 600 })
    store.setState({ zoomLevel: 1, viewportOffset: { x: 0, y: 0 }, selection: [], selectionActive: false })

    const panels: Record<string, PanelState> = {
      'p-url': panel('p-url', 'acme.remote'),
      'p-local': panel('p-local', 'acme.local'),
    }
    const keepMounted = keepMountedOffscreenPanelIds(panels, new Set(['acme.remote']))
    const visible = selectVisibleNodeIds(store.getState(), keepMounted)

    expect(visible).not.toContain(urlNode)
    expect(visible).toContain(localNode)
  })
})

// ---------------------------------------------------------------------------
// Referential stability — the cull's keep-alive cache is keyed on this set's
// identity, so unrelated store updates must NOT mint a new Set.
// ---------------------------------------------------------------------------
describe('useKeepMountedPanelIds — referential stability', () => {
  const wsId = 'ws-1'

  beforeEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      extensionList: vi.fn(async () => []),
      onExtensionsChanged: vi.fn(),
    }
    useExtensionsStore.setState({
      entries: [entry('acme.remote', { url: 'https://jira.example.com' }), entry('acme.local', { frontend: 'i.html' })],
    })
    useAppStore.setState({
      workspaces: [
        {
          ...(useAppStore.getState().workspaces[0] ?? {}),
          id: wsId,
          name: 'ws',
          rootPath: '/tmp/ws',
          panels: {
            'p-url': panel('p-url', 'acme.remote'),
            'p-local': panel('p-local', 'acme.local'),
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

    expect([...seen[0]]).toEqual(['p-local'])

    // Unrelated panel churn: a title edit swaps the panels record, re-running the
    // selector. Equal membership → zustand hands back the SAME object.
    act(() => {
      useAppStore.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === wsId
            ? { ...w, panels: { ...w.panels, 'p-local': { ...w.panels['p-local'], title: 'renamed' } } }
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

    // A real membership change (the url-mode extension is now unknown) DOES
    // produce a new set — the local-extension default takes over.
    act(() => { useExtensionsStore.setState({ entries: [] }) })
    const latest = seen[seen.length - 1]
    expect(latest).not.toBe(seen[0])
    expect([...latest].sort()).toEqual(['p-local', 'p-url'])

    act(() => { root.unmount() })
    container.remove()
  })
})
