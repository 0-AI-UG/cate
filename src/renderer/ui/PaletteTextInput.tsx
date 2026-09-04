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
    <div className={`flex h-8 items-center gap-2 rounded-md border border-strong bg-surface-0/60 px-2.5 transition-colors focus-within:border-[rgba(255,255,255,0.18)] ${containerClassName}`}>
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
