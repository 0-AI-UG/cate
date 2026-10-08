// What an empty layout shows: the panel types this client can open, as the
// chooser a split's "Open a surface" placeholder shows. A pick creates the
// panel as the layout's first tab.

import React from 'react'
import { Icon } from '../../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import type { DockRef } from '@workspace/document/contract'
import { createPanel, creatableDefinitions, newId } from '@client/host'

export function EmptyDockChooser({ workspaceId, dock }: {
  workspaceId: string
  /** The empty dock the pick fills; without one, the main window's shown layout. */
  dock?: DockRef
}): JSX.Element {
  const choices = creatableDefinitions()
  return (
    <div data-empty-workspace-dock className="relative h-full min-h-0 w-full isolate">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      <div className="relative flex h-full min-h-0 flex-col overflow-y-auto p-4">
        <div className="m-auto w-full max-w-lg py-4">
          <div role="group" aria-label="Open a surface" className="flex flex-col gap-1">
            {choices.map((definition) => (
              <button
                type="button"
                key={definition.type}
                onClick={() => { createPanel(workspaceId, definition.type, dock ? { at: { to: 'stack', dock, stackId: newId() } } : {}) }}
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
