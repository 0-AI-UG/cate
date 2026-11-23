// The one search/filter input of the desktop UI: same height, frame, icon and
// clear button everywhere (sidebar, settings, panels, pages). Escape clears a
// non-empty query before anything else sees the key.

import { forwardRef, type InputHTMLAttributes } from 'react'
import { Search, X } from 'lucide-react'
import { PaletteTextInput } from './PaletteTextInput'

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string
  onValueChange: (value: string) => void
  containerClassName?: string
  /** Escape empties a non-empty query first (default); false lets it through. */
  clearOnEscape?: boolean
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField({
  value,
  onValueChange,
  onKeyDown,
  containerClassName,
  clearOnEscape = true,
  placeholder = 'Search',
  ...props
}, ref) {
  return (
    <PaletteTextInput
      {...props}
      ref={ref}
      type="search"
      inputClassName="[&::-webkit-search-cancel-button]:appearance-none"
      spellCheck={false}
      aria-label={props['aria-label'] ?? placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value && clearOnEscape) {
          event.preventDefault()
          event.stopPropagation()
          onValueChange('')
          return
        }
        onKeyDown?.(event)
      }}
      icon={<Search size={14} />}
      containerClassName={containerClassName}
      trailing={value ? (
        <button type="button" aria-label="Clear search" onClick={() => onValueChange('')}
          className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-primary">
          <X size={12} />
        </button>
      ) : undefined}
    />
  )
})
