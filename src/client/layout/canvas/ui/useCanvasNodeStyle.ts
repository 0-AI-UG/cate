// Inline styles of a node's frame and its focus glow layer, memoised so their
// identities stay stable across renders.

import type React from 'react'
import { useMemo } from 'react'
import { NODE_CORNER_RADIUS } from '../constants'
import type { ViewNode } from '../store'

// Above any realistic node z band (1000 + zOrder), so a selected node's ring
// is never painted under an overlapping neighbour.
const GLOW_Z = 100000

const SHADOW_UNFOCUSED = '0 12px 36px -14px rgba(0,0,0,0.28), 0 4px 10px -5px rgba(0,0,0,0.16)'
const SHADOW_HOVERED = `${SHADOW_UNFOCUSED}, 0 0 18px rgba(255,255,255,0.015)`
const FOCUS_GLOW = '0 0 20px 1px rgba(255,255,255,0.025), 0 0 8px rgba(255,255,255,0.02)'
// Selected but not active (marquee, Cmd+Arrow): a crisp accent ring.
const SELECTION_RING = '0 0 0 2px var(--focus-blue), 0 0 14px -2px var(--focus-blue)'

interface StyleArgs {
  node: ViewNode | undefined
  isFocused: boolean
  isSelected: boolean
  isHovered: boolean
  isWholeNodeDragSource: boolean
  /** The active tab's worktree colour; null when untagged or with one worktree. */
  worktreeColor?: string | null
  /** The node's worktree is hovered or is the lens target. */
  worktreeHighlight?: boolean
  /** The lens is on another worktree: this node recedes. */
  worktreeDim?: boolean
}

export function useCanvasNodeStyle(args: StyleArgs) {
  const { node, isFocused, isSelected, isHovered, isWholeNodeDragSource, worktreeColor, worktreeHighlight, worktreeDim } = args

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }
    const entering = node.animationState === 'entering'
    const exiting = node.animationState === 'exiting'
    const baseOpacity = entering || exiting ? 0 : 1
    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: 1000 + node.zOrder,
      borderRadius: NODE_CORNER_RADIUS,
      ['--node-inner-radius' as string]: `calc(${NODE_CORNER_RADIUS}px - var(--hairline))`,
      ['--node-tab-radius' as string]: `calc(${NODE_CORNER_RADIUS}px - var(--hairline) - 2px)`,
      overflow: 'hidden',
      border: 'var(--hairline) solid var(--border-subtle)',
      boxShadow: isHovered ? SHADOW_HOVERED : SHADOW_UNFOCUSED,
      backgroundColor: 'var(--node-bg-active)',
      ['--node-chrome-bg' as string]: 'var(--surface-1)',
      ['--node-chrome-active-bg' as string]: 'var(--surface-3)',
      ['--node-chrome-accent' as string]: 'var(--focus-blue)',
      transition: 'border-color 150ms ease, box-shadow 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out, filter 200ms ease',
      filter: worktreeDim ? 'saturate(0.4)' : undefined,
      transform: entering ? 'scale(0.85)' : exiting ? 'scale(0.9)' : 'scale(1)',
      opacity: worktreeDim ? baseOpacity * 0.5 : baseOpacity,
      // A webview guest can stay painted through an opacity:0 ancestor;
      // visibility reliably hides it while the drag ghost stands in.
      visibility: isWholeNodeDragSource ? 'hidden' : undefined,
      pointerEvents: exiting || isWholeNodeDragSource ? 'none' : undefined,
      userSelect: 'none',
    }
  }, [node, isHovered, isWholeNodeDragSource, worktreeDim])

  const glowStyle = useMemo<React.CSSProperties | null>(() => {
    if (!node) return null
    if (!(isFocused || isSelected || worktreeHighlight)) return null
    if (isWholeNodeDragSource) return null
    const entering = node.animationState === 'entering'
    const exiting = node.animationState === 'exiting'
    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      // Paints only an outset shadow with pointer-events off, so drawing it
      // above other nodes never blocks or hides them.
      zIndex: GLOW_Z,
      borderRadius: NODE_CORNER_RADIUS,
      boxShadow:
        worktreeHighlight && worktreeColor
          ? `0 0 0 2px ${worktreeColor}, 0 0 18px -2px ${worktreeColor}`
          : isFocused ? FOCUS_GLOW : SELECTION_RING,
      pointerEvents: 'none',
      transform: entering ? 'scale(0.85)' : exiting ? 'scale(0.9)' : 'scale(1)',
      opacity: entering || exiting ? 0 : 1,
      transition: 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out, box-shadow 200ms ease',
    }
  }, [node, isFocused, isSelected, isWholeNodeDragSource, worktreeHighlight, worktreeColor])

  return { containerStyle, glowStyle }
}
