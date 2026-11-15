import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

interface PaletteTextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon: ReactNode
  trailing?: ReactNode
  containerClassName?: string
  inputClassName?: string
}

export const PaletteTextInput = forwardRef<HTMLInputElement, PaletteTextInputProps>(function PaletteTextInput({
  icon,
  trailing,
  containerClassName = '',
  inputClassName = '',
  type = 'text',
  ...props
}, ref) {
  return (
    <div data-input-frame className={`flex h-8 items-center gap-2 rounded-md border border-subtle bg-surface-2 px-2.5 text-secondary transition-colors hover:border-strong focus-within:border-strong focus-within:text-primary ${containerClassName}`}>
      <span className="shrink-0 text-muted" aria-hidden="true">{icon}</span>
      <input
        {...props}
        ref={ref}
        type={type}
        className={`min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-muted ${inputClassName}`}
      />
      {trailing}
    </div>
  )
})
