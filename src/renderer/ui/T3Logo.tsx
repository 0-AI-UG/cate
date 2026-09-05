import { T3_LOGO_PATH, T3_LOGO_VIEW_BOX } from '../../shared/t3Logo'
import type { CSSProperties } from 'react'

/** Official T3 Code wordmark, from t3@0.0.38 SidebarChrome.tsx. */
export function T3Logo({ size = 18, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="T3 Code"
      width={size}
      height={size}
      viewBox={T3_LOGO_VIEW_BOX}
      className={className}
      style={style}
    >
      <path fill="currentColor" d={T3_LOGO_PATH} />
    </svg>
  )
}
