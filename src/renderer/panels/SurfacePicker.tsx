import React from 'react'
import type { PanelType } from '../../shared/types'
import { getPanelDef } from './registry'

const surfaces: { type: PanelType; title: string }[] = [
  { type: 'browser', title: 'Browser' },
  { type: 'terminal', title: 'Terminal' },
  { type: 'editor', title: 'Files' },
  { type: 'review', title: 'Diff' },
  { type: 'agent', title: 'T3 Code' },
  { type: 'sourceControl', title: 'Source Control' },
  { type: 'canvas', title: 'Canvas' },
]

export default function SurfacePicker({ onSelect, excludePanelTypes }: {
  onSelect?: (type: PanelType) => void
  excludePanelTypes?: PanelType[]
}) {
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
    <div className="m-auto w-full max-w-lg py-4">
      <div role="group" aria-label="Open a surface" className="flex flex-col gap-1">
        {surfaces.filter((surface) => !excludePanelTypes?.includes(surface.type)).map((surface) => {
          const Icon = getPanelDef(surface.type).icon
          return <button type="button" key={surface.type} disabled={!onSelect} onClick={() => onSelect?.(surface.type)} className="flex min-h-10 items-center rounded-lg bg-surface-1 px-3 py-2 text-left text-primary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
            <span className="flex items-center gap-3 text-[13px]"><Icon size={16} className="shrink-0 text-muted" />{surface.title}</span>
          </button>
        })}
      </div>
    </div>
  </div>
}
