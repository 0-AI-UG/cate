// Renaming a chip in place (a layout's or a panel's, in a window's strip or a node's): the chip swaps its label for this input.

import React, { useEffect, useRef, useState } from 'react'
import type { LayoutId } from '@workspace/document/contract'
import { renamePanelChange } from '@workspace/document/contract'
import { documentStoreFor } from '@client/document'
import { renameLayout } from '@client/host'

export function useChipRename(commitName: (id: string, name: string) => void) {
  const [renameId, setRenameId] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const seed = useRef('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameId) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [renameId])
  // A blank or untouched name writes nothing.
  const commit = (id: string) => {
    const name = value.trim()
    if (name && name !== seed.current) commitName(id, name)
    setRenameId(null)
  }
  return {
    renameId,
    begin: (id: string, name: string) => { seed.current = name; setValue(name); setRenameId(id) },
    input: (id: string, className: string) => (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(id) }
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

export function useLayoutRename(workspaceId: string) {
  const rename = useChipRename((id, name) => renameLayout(workspaceId, id, name))
  return { renameId: rename.renameId, input: rename.input, begin: (layout: { id: LayoutId; name: string }) => rename.begin(layout.id, layout.name) }
}

export function usePanelRename(workspaceId: string) {
  return useChipRename((id, title) => { documentStoreFor(workspaceId)?.propose(renamePanelChange(id, title)) })
}
