// What this window shows, by the core's rule (`windowContent`): a workspace
// while the selected one is listed, else the welcome screen. Views that
// decide between them render this; navigation keeps the selection itself
// reconciled with the list (`reconcileWindow`), so the two always agree.

import { useMemo } from 'react'
import { windowContent, type WindowContent } from '@client/workspaces'
import { useWorkspaceList } from '../../client/workspaces'
import { clientApp } from '../app'
import { useUIStore } from './uiStore'

export function useWindowContent(): WindowContent {
  const selected = useUIStore((s) => s.selectedWorkspaceId)
  const { entries } = useWorkspaceList(clientApp().workspaces)
  return useMemo(() => windowContent(selected, entries), [selected, entries])
}

/** The workspace the window shows; null on the welcome screen. */
export function useShownWorkspaceId(): string | null {
  const content = useWindowContent()
  return content.kind === 'workspace' ? content.workspaceId : null
}
