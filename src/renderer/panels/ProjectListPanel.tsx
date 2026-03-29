// =============================================================================
// ProjectListPanel — Dockable panel wrapping the ProjectList workspace list.
// =============================================================================

import React from 'react'
import { ProjectList } from '../sidebar/ProjectList'
import type { PanelProps } from './types'

export default function ProjectListPanel({ panelId, workspaceId }: PanelProps) {
  return (
    <div className="w-full h-full overflow-auto bg-[#1e1e1e]">
      <ProjectList />
    </div>
  )
}
