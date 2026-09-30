// The settings window's pages. Each slice owner's page registers here (the
// window never imports a module's page by name): client/ui registers the pages
// of the modules below it at start, the desktop shell registers its own
// (General, Updates), and higher modules register theirs. A workspace page
// shows only while a workspace is active and edits that workspace's settings
// for everyone in it.

import { useSyncExternalStore, type ComponentType } from 'react'
import type { ClientFeature } from '@kernel/rpc/contract'

export type SettingsGroup = 'general' | 'workspace' | 'tools' | 'agents'

export const SETTINGS_GROUPS: readonly { id: SettingsGroup; title: string }[] = [
  { id: 'general', title: 'General' },
  { id: 'workspace', title: 'Workspace' },
  { id: 'tools', title: 'Tools' },
  { id: 'agents', title: 'Agents' },
]

export interface SettingsPageProps {
  /** The active workspace; always set for a workspace page. */
  workspaceId: string | null
}

export interface SettingsPage {
  /** Stable, lowercase; `openSettings(id)` scrolls to it. */
  id: string
  title: string
  group: SettingsGroup
  /** `workspace` pages need an active workspace. */
  scope: 'client' | 'workspace'
  /** Position within the group; lower first. */
  order?: number
  requires?: readonly ClientFeature[]
  component: ComponentType<SettingsPageProps>
}

const pages = new Map<string, SettingsPage>()
const listeners = new Set<() => void>()
let snapshot: readonly SettingsPage[] = []

const changed = (): void => {
  const groupRank = new Map(SETTINGS_GROUPS.map((g, i) => [g.id, i]))
  snapshot = [...pages.values()].sort((a, b) =>
    (groupRank.get(a.group)! - groupRank.get(b.group)!) || ((a.order ?? 100) - (b.order ?? 100)) || a.title.localeCompare(b.title))
  for (const l of [...listeners]) l()
}

/** Registers a page; a second page with the same id replaces the first. */
export function registerSettingsPage(page: SettingsPage): () => void {
  pages.set(page.id, page)
  changed()
  return () => {
    if (pages.get(page.id) !== page) return
    pages.delete(page.id)
    changed()
  }
}

export function settingsPages(): readonly SettingsPage[] {
  return snapshot
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useSettingsPages(): readonly SettingsPage[] {
  return useSyncExternalStore(subscribe, settingsPages)
}

/** The pages to show: workspace pages only with a workspace, and only pages
 *  whose features this client has. */
export function visiblePages(
  all: readonly SettingsPage[],
  workspaceId: string | null,
  has: (feature: ClientFeature) => boolean,
): SettingsPage[] {
  return all.filter((page) => (page.scope === 'client' || workspaceId !== null) && (page.requires ?? []).every(has))
}

/** The page a section id or title names, else the first page. */
export function resolveSectionId(section: string | undefined, available: readonly SettingsPage[]): string | undefined {
  if (!section) return available[0]?.id
  const id = section.toLowerCase()
  return available.find((p) => p.id === id || p.title.toLowerCase() === id)?.id ?? available[0]?.id
}
