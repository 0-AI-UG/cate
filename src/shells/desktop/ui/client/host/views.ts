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

/** Registers a panel type's view. `load` is a dynamic import so each view is
 *  its own chunk. */
export function registerPanelView(type: PanelType, load: () => Promise<{ default: AnyView }>): void {
  views.set(type, lazy(load))
}

export function panelView(type: PanelType): LazyExoticComponent<AnyView> | undefined {
  return views.get(type)
}
