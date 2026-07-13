// =============================================================================
// CreateFileForm — shared inline "new file / new folder" row for the sidebar.
// Used by both the file-tree node (create inside a folder, indented by depth)
// and the explorer root (create at the workspace root). Layout, icon colors and
// the input itself were duplicated verbatim across both call sites; only the
// left padding and the icon size differ, so both are parameterised. The caller
// owns the value/handlers and the input ref (for focus-on-mount wiring).
// =============================================================================

import React, { forwardRef } from 'react'
import { Folder, File } from '@phosphor-icons/react'
import { InlineEditInput } from './InlineEditInput'

export interface CreateFileFormProps {
  type: 'file' | 'folder'
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  /** Inline style left-padding for the row (matches the tree's indent math). */
  paddingLeft: string
  /** Icon pixel size (file tree uses the shared ICON_PROPS size of 14). */
  iconSize?: number
}

export const CreateFileForm = forwardRef<HTMLInputElement, CreateFileFormProps>(
  ({ type, value, onChange, onSubmit, onCancel, paddingLeft, iconSize = 14 }, ref) => (
    <div className="h-7 flex items-center gap-1.5 px-2" style={{ paddingLeft }}>
      <span className="flex-shrink-0 w-3" />
      <span className="flex-shrink-0" style={{ color: type === 'folder' ? '#E2B855' : '#9CA3AF' }}>
        {type === 'folder' ? <Folder size={iconSize} /> : <File size={iconSize} />}
      </span>
      <InlineEditInput
        ref={ref}
        className="flex-1 min-w-0 bg-surface-5 text-primary text-sm px-1 rounded border border-focus outline-none"
        value={value}
        placeholder={type === 'folder' ? 'folder name' : 'file name'}
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
        stopKeyPropagation
      />
    </div>
  ),
)

CreateFileForm.displayName = 'CreateFileForm'
