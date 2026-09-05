import { CheckCircle } from '@phosphor-icons/react'

export interface CompactChoiceOption<T extends string | number> {
  value: T
  label: string
  title?: string
}

export function CompactChoiceList<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<CompactChoiceOption<T>>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="text-[11px]">
      <div className="mb-1.5 text-[10px] text-muted">{label}</div>
      <div className="divide-y divide-subtle overflow-hidden rounded-md border border-subtle bg-surface-2">
        {options.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              title={option.title}
              onClick={() => onChange(option.value)}
              className={`flex h-6 w-full items-center gap-1.5 px-2 text-left text-[10px] transition-colors ${
                selected ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected && <CheckCircle size={10} weight="fill" className="shrink-0 text-agent-light" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
