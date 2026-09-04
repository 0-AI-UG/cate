import { Plus, X } from '@phosphor-icons/react'
import { Button, IconButton } from '../ui/Button'
import { InlineNotice } from '../ui/InlineNotice'
import { TextInput } from './SettingsComponents'

export function StringListEditor({
  values,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  placeholder,
  error,
  emptyMessage,
}: {
  values: string[]
  draft: string
  onDraftChange: (value: string) => void
  onAdd: () => void
  onRemove: (value: string) => void
  placeholder: string
  error?: string | null
  emptyMessage?: string
}) {
  return (
    <>
      <div className="flex gap-1.5">
        <TextInput
          value={draft}
          onChange={onDraftChange}
          onKeyDown={(event) => { if (event.key === 'Enter') onAdd() }}
          placeholder={placeholder}
          layoutClassName="flex-1 px-2"
        />
        <Button size="sm" onClick={onAdd} className="h-auto px-2.5 text-[12px]">
          <Plus size={12} />
          Add
        </Button>
      </div>

      {error && <InlineNotice tone="error" className="mt-2 border-0 bg-transparent px-0 py-0">{error}</InlineNotice>}

      {values.length === 0 && emptyMessage ? (
        <div className="mt-3 px-0.5 py-1 text-[11px] italic text-muted">{emptyMessage}</div>
      ) : values.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className="group inline-flex items-center gap-1 rounded border border-subtle bg-surface-5 py-0.5 pl-2 pr-1 font-mono text-[12px] text-primary"
            >
              {value}
              <IconButton
                label={`Remove ${value}`}
                size={16}
                tone="danger"
                onClick={() => onRemove(value)}
                className="p-0.5"
              >
                <X size={11} />
              </IconButton>
            </span>
          ))}
        </div>
      ) : null}
    </>
  )
}
