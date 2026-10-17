// A thin progress bar: a fraction it fills (only ever forward is the
// caller's business), or a sweep when how far is not known.

export function ProgressBar({ value, label, className = '' }: {
  /** 0..1; null when how far is not known. */
  value: number | null
  label: string
  className?: string
}): JSX.Element {
  const known = value !== null
  const fraction = known ? Math.max(0, Math.min(1, value)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(fraction * 100) : undefined}
      className={`relative h-1.5 overflow-hidden rounded-full bg-surface-5 ${className}`}
    >
      {known
        ? <div className="h-full rounded-full bg-focus-blue transition-[width] duration-300" style={{ width: `${fraction * 100}%` }} />
        : <div className="h-full w-full rounded-full bg-focus-blue/60 animate-pulse motion-reduce:animate-none" />}
    </div>
  )
}
