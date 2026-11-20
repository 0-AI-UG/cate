// The new-tab button: opens an "Open a surface" tab, the chooser of panel types.

import React from 'react'
import { Plus } from 'lucide-react'
import { Tooltip } from '../../../kernel/interaction'

export function NewTabButton({ compact, onNewTab }: { compact?: boolean; onNewTab: () => void }) {
  return (
    <Tooltip label="New Tab">
      <button
        type="button"
        aria-label="New Tab"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`flex shrink-0 items-center justify-center self-center rounded-[var(--node-tab-radius,6px)] text-muted bg-[color-mix(in_srgb,var(--surface-2)_45%,transparent)] hover:text-primary hover:bg-surface-2 transition-colors duration-100 motion-reduce:transition-none cursor-pointer ${compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'}`}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onNewTab}
      ><Plus size={compact ? 12 : 13} /></button>
    </Tooltip>
  )
}
