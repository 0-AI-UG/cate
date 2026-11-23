// What an empty main window shows: the logo the opening surface showed and
// the panel types this client can open, as the chooser a split's "Open a
// surface" placeholder shows. A pick creates the panel as the window's first
// tab. No grid: it would read as a canvas.

import React from 'react'
import { CateLogo } from '../../../kernel/interaction'
import { SurfaceChoiceList } from './SurfaceChoiceList'
import { createPanel, creatableDefinitions } from '@client/host'

export function EmptyDockChooser({ workspaceId }: { workspaceId: string }): JSX.Element {
  const choices = creatableDefinitions()
  return (
    <div data-empty-workspace-dock className="relative h-full min-h-0 w-full isolate bg-surface-0">
      <div className="relative flex h-full min-h-0 flex-col overflow-y-auto p-4">
        <div className="m-auto flex w-full max-w-xs flex-col items-center gap-5 py-4">
          <CateLogo size={61} className="shrink-0 text-muted opacity-60" aria-hidden="true" />
          <SurfaceChoiceList choices={choices} onPick={(type) => { createPanel(workspaceId, type) }} />
        </div>
      </div>
    </div>
  )
}
