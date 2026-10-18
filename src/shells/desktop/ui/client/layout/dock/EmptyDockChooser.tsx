// What an empty main window shows: the logo the opening surface showed and
// the panel types this client can open, as the chooser a split's "Open a
// surface" placeholder shows. A pick creates the panel as the window's first
// tab. No grid: it would read as a canvas.

import React from 'react'
import { CateLogo, Icon } from '../../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import { createPanel, creatableDefinitions } from '@client/host'

export function EmptyDockChooser({ workspaceId }: { workspaceId: string }): JSX.Element {
  const choices = creatableDefinitions()
  return (
    <div data-empty-workspace-dock className="relative h-full min-h-0 w-full isolate">
      <div className="relative flex h-full min-h-0 flex-col overflow-y-auto p-4">
        <div className="m-auto flex w-full max-w-lg flex-col items-center gap-5 py-4">
          <CateLogo size={61} className="shrink-0 text-muted opacity-60" aria-hidden="true" />
          <div role="group" aria-label="Open a surface" className="flex w-full flex-col gap-1">
            {choices.map((definition) => (
              <button
                type="button"
                key={definition.type}
                onClick={() => { createPanel(workspaceId, definition.type) }}
                className="flex min-h-10 items-center rounded-lg bg-surface-1 px-3 py-2 text-left text-primary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span className="flex items-center gap-3 text-[13px]">
                  {isIconName(definition.icon) && <Icon name={definition.icon} size={16} className="shrink-0 text-muted" />}
                  {definition.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
