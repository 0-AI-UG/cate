// Each panel type's desktop view (architecture 11.1). PanelHost renders every
// panel through here; each panel's view entry registers its component, so the
// host never imports a panel type.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { PanelRecord, PanelType } from '@workspace/document/contract'
import type { SessionHandle } from '@client/connections'

export interface PanelViewProps<S = unknown, Op = unknown> {
  workspaceId: string
  panelId: string
  record: PanelRecord
  /** The panel's session channel, shared by every view of the panel on this client. */
  session: SessionHandle<S>
  /** Sends one typed op to the session. */
  send: (op: Op) => Promise<unknown>
  /** The latest snapshot; null until the first one arrives. */
  snapshot: S | null
  /** The view is on screen (its tab is active and its window is visible). */
  visible: boolean
  /** The view holds keyboard focus. */
  focused: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyView = ComponentType<PanelViewProps<any, any>>

const views = new Map<PanelType, LazyExoticComponent<AnyView>>()
const loaders = new Map<PanelType, () => Promise<{ default: AnyView }>>()
const loaded = new Set<PanelType>()

/** Registers a panel type's view. `load` is a dynamic import so each view is
 *  its own chunk, loaded once whether rendered or preloaded first. */
export function registerPanelView(type: PanelType, load: () => Promise<{ default: AnyView }>): void {
  let loading: Promise<{ default: AnyView }> | null = null
  const once = () => {
    loading ??= load().then((module) => {
      loaded.add(type)
      return module
    }, (err: unknown) => {
      loading = null
      throw err
    })
    return loading
  }
  loaders.set(type, once)
  views.set(type, lazy(once))
}

/** Whether the views of `types` are loaded (or not registered). */
export function panelViewsLoaded(types: Iterable<PanelType>): boolean {
  for (const type of types) if (loaders.has(type) && !loaded.has(type)) return false
  return true
}

/** Loads the views of `types` ahead of rendering them; settles either way
 *  (a view that fails to load fails where it renders). */
export async function preloadPanelViews(types: Iterable<PanelType>): Promise<void> {
  await Promise.allSettled([...new Set(types)].map((type) => loaders.get(type)?.()))
}

export function panelView(type: PanelType): LazyExoticComponent<AnyView> | undefined {
  return views.get(type)
}
