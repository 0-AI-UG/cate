import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  /** Sweep a highlight over the text (work in progress). */
  active: boolean
  /** The text color; while active the sweep runs from it to white. */
  color?: string
}

/**
 * Text with a highlight sweeping over it while `active`. The sweep moves only
 * transforms, so the compositor runs it without repainting: a bright copy of
 * the text sits in a masked band that slides across while the copy slides the
 * other way by the same amount and stays over the text. Painting a moving
 * gradient into the text itself (the old `background-clip: text` shimmer)
 * repainted the window every frame while any agent ran.
 */
export function ShimmerText({ children, active, color, className = '', style, ...props }: ShimmerTextProps) {
  const colors = color ? { '--shimmer-dim': color, '--shimmer-bright': '#ffffff' } : undefined
  return (
    <span
      {...props}
      className={`${active ? 'cate-shimmer' : ''} ${className}`}
      style={active ? { ...colors, ...style } as CSSProperties : { color, ...style }}
    >
      {children}
      {active && (
        <span aria-hidden className="cate-shimmer-band">
          <span className="cate-shimmer-copy">{children}</span>
        </span>
      )}
    </span>
  )
}
