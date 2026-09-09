import React from 'react'
import type { PanelType } from '../../shared/types'
import { getPanelDef } from './registry'

import { SPLIT_MENU_PANEL_TYPES } from '../../shared/panels'

export default function SurfacePicker({ onSelect, excludePanelTypes }: {
  onSelect?: (type: PanelType) => void
  excludePanelTypes?: PanelType[]
}) {
  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
    <div className="m-auto w-full max-w-lg py-4">
      <div role="group" aria-label="Open a surface" className="flex flex-col gap-1">
        {SPLIT_MENU_PANEL_TYPES.filter((type) => !excludePanelTypes?.includes(type)).map((type) => {
          const { icon: Icon, label } = getPanelDef(type)
          return <button type="button" key={type} disabled={!onSelect} onClick={() => onSelect?.(type)} className="flex min-h-10 items-center rounded-lg bg-surface-1 px-3 py-2 text-left text-primary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
            <span className="flex items-center gap-3 text-[13px]"><Icon size={16} className="shrink-0 text-muted" />{label}</span>
          </button>
        })}
      </div>
    </div>
  </div>
}
