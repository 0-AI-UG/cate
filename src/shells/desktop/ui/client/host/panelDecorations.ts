// Presentation contributed by services, consumed by every panel title.

import { useRef, type ReactNode } from 'react'

export interface PanelDecoration {
  /** Replaces the type icon. */
  logo?: string | null
  logoAlt?: string | null
  /** A status mark drawn after the title. */
  status?: ReactNode
  /** The title shimmers (work in progress). */
  busy?: boolean
  /** The title ends with a dot (unsaved changes). */
  dirty?: boolean
  /** The title to show for the record's title. */
  retitle?: (title: string) => string
}

/** A React hook: decorations for the workspace's panels, keyed by id. */
export type PanelDecorationHook = (workspaceId: string) => Readonly<Record<string, PanelDecoration>>

const decorationHooks: PanelDecorationHook[] = []

export function registerPanelDecorations(hook: PanelDecorationHook): () => void {
  decorationHooks.push(hook)
  return () => {
    const index = decorationHooks.indexOf(hook)
    if (index >= 0) decorationHooks.splice(index, 1)
  }
}

/** Every registered decoration merged per panel. */
export function usePanelDecorations(workspaceId: string): Record<string, PanelDecoration> {
  const sources: Readonly<Record<string, PanelDecoration>>[] = []
  for (const hook of decorationHooks) sources.push(hook(workspaceId))
  const cache = useRef<{ sources: typeof sources; merged: Record<string, PanelDecoration> } | null>(null)
  if (cache.current && sources.length === cache.current.sources.length && sources.every((source, index) => source === cache.current!.sources[index])) return cache.current.merged
  const merged: Record<string, PanelDecoration> = {}
  for (const source of sources) for (const [id, decoration] of Object.entries(source)) merged[id] = { ...merged[id], ...decoration }
  cache.current = { sources, merged }
  return merged
}
