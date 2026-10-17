// The strip a window edge shows while a drag hovers it: dropping there splits
// the window's whole dock on that side.

import React from 'react'
import type { SplitSide } from '@workspace/document/contract'

const STRIP = 'rgba(74, 158, 255, 0.15)'
const LINE = '2px solid rgba(74, 158, 255, 0.6)'

export function EdgeDropIndicator({ edge }: { edge: SplitSide }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    zIndex: 9999,
    pointerEvents: 'none',
    transition: 'all 150ms ease',
    backgroundColor: STRIP,
  }
  switch (edge) {
    case 'left':
      Object.assign(style, { top: 0, left: 0, bottom: 0, width: 240, borderRight: LINE })
      break
    case 'right':
      Object.assign(style, { top: 0, right: 0, bottom: 0, width: 240, borderLeft: LINE })
      break
    case 'bottom':
      Object.assign(style, { left: 0, right: 0, bottom: 0, height: 180, borderTop: LINE })
      break
    case 'top':
      Object.assign(style, { left: 0, right: 0, top: 0, height: 180, borderBottom: LINE })
      break
  }
  return <div data-drag-indicator={`edge-${edge}`} style={style} />
}
