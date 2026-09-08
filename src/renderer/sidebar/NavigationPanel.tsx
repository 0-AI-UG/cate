import React from 'react'
import { SidebarViewContent } from './Sidebar'
import { useAppStore } from '../stores/appStore'
import type { SidebarView } from '../../shared/types'

export default function NavigationPanel({ workspaceId, view }: { workspaceId: string; view: SidebarView }) {
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? '')
  return <SidebarViewContent workspaceId={workspaceId} view={view} rootPath={rootPath} />
}
