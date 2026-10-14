// Renaming a layout in place, from a window's strip or a node's: the chip swaps its label for this input.

import React, { useEffect, useRef, useState } from 'react'
import type { DockLayout, LayoutId } from '@workspace/document/contract'
import { renameLayout } from '@client/host'

export function useLayoutRename(workspaceId: string) {
  const [renameId, setRenameId] = useState<LayoutId | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameId) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [renameId])
  // A blank name is refused by `renameLayout`: the layout keeps the one it has.
  const commit = (layoutId: LayoutId) => { renameLayout(workspaceId, layoutId, value); setRenameId(null) }
  return {
    renameId,
    begin: (layout: DockLayout) => { setValue(layout.name); setRenameId(layout.id) },
    input: (layoutId: LayoutId, className: string) => (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(layoutId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(layoutId) }
          else if (e.key === 'Escape') { e.preventDefault(); setRenameId(null) }
          e.stopPropagation()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className={`bg-transparent outline-none border-b border-focus text-primary ${className}`}
        style={{ font: 'inherit' }}
      />
    ),
  }
}
