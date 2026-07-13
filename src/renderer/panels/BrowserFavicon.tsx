// =============================================================================
// BrowserFavicon — a tab/bookmark favicon with a graceful fallback. Renders the
// page-reported favicon as an <img>; on a load error (or when no favicon is
// known yet) it falls back to a globe glyph so the tab always has an icon.
// =============================================================================
import { useEffect, useState } from 'react'
import { Globe } from '@phosphor-icons/react'

interface Props {
  src?: string
  size?: number
  className?: string
}

export function BrowserFavicon({ src, size = 14, className = '' }: Props): JSX.Element {
  const [errored, setErrored] = useState(false)
  // Reset the error flag whenever the source changes so a new favicon gets a
  // fresh load attempt (a stuck `errored` would keep showing the globe).
  useEffect(() => setErrored(false), [src])

  if (!src || errored) {
    return <Globe size={size} className={`text-muted shrink-0 ${className}`} />
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setErrored(true)}
      className={`shrink-0 rounded-sm object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
