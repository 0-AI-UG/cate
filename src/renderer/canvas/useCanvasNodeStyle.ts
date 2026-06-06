// =============================================================================
// useCanvasNodeStyle — derived inline-style memos for CanvasNode's wrapper
// and its sibling focus-glow layer. Kept as a hook (not a pure helper) so the
// memo identities are stable across renders, matching the original inline
// useMemo calls.
// =============================================================================

import React, { useMemo } from 'react'
import type { CanvasNodeState, NodeActivityState } from '../../shared/types'

const CORNER_RADIUS = 8

const SHADOW_UNFOCUSED = `0 12px 36px -14px rgba(0,0,0,0.28), 0 4px 10px -5px rgba(0,0,0,0.16)`
const SHADOW_HOVERED = `${SHADOW_UNFOCUSED}, 0 0 18px rgba(255,255,255,0.015)`
// Active/focused pane: a very faint bright (white) halo — no blue tint.
const FOCUS_GLOW = `0 0 20px 1px rgba(255,255,255,0.025), 0 0 8px rgba(255,255,255,0.02)`

function boxShadow(hovered: boolean): string {
  if (hovered) return SHADOW_HOVERED
  return SHADOW_UNFOCUSED
}

function activityOutline(activity: NodeActivityState | undefined): string {
  if (!activity) return 'none'
  switch (activity.type) {
    case 'commandFinished':
      return '2px solid var(--activity-green)'
    case 'agentWaitingForInput':
      return '2px solid var(--activity-orange)'
    default:
      return 'none'
  }
}

interface StyleArgs {
  node: CanvasNodeState | undefined
  isFocused: boolean
  activityState: NodeActivityState | undefined
  isAnimatingLayout: boolean
  isHovered: boolean
  chromeTint: { background: string; accent: string } | null
  isWholeNodeDragSource: boolean
  /** Active tab's worktree color, or null when the node isn't worktree-tagged
   *  (or the workspace has <2 worktrees). Tints the node border. */
  worktreeColor?: string | null
  /** This node's worktree is hovered or is the focus-lens target → colored ring. */
  worktreeHighlight?: boolean
  /** The focus lens is locked on a DIFFERENT worktree → push this node back. */
  worktreeDim?: boolean
}

export function useCanvasNodeStyle(args: StyleArgs) {
  const {
    node,
    isFocused,
    activityState,
    isAnimatingLayout,
    isHovered,
    chromeTint,
    isWholeNodeDragSource,
    worktreeColor,
    worktreeHighlight,
    worktreeDim,
  } = args

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }

    const isPulsing = activityState?.type === 'agentWaitingForInput'
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'

    const baseTransition =
      'border-color 150ms ease, box-shadow 200ms ease, outline-color 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out, filter 200ms ease'
    const layoutTransition = isAnimatingLayout
      ? ', left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      : ''

    const baseOpacity = isEntering ? 0 : isExiting ? 0 : isWholeNodeDragSource ? 0 : 1
    // Focus lens: nodes outside the focused worktree recede.
    const opacity = worktreeDim ? baseOpacity * 0.5 : baseOpacity

    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: 1000 + node.zOrder,
      borderRadius: CORNER_RADIUS,
      overflow: 'hidden',
      border: `1.5px solid var(--border-subtle)`,
      boxShadow: boxShadow(isHovered),
      outline: activityOutline(activityState),
      outlineOffset: -1,
      animation: isPulsing ? 'pulseActivity 1s ease-in-out infinite alternate' : undefined,
      backgroundColor: chromeTint?.background ?? 'var(--node-bg-active)',
      ['--node-chrome-bg' as any]: chromeTint?.background ?? 'var(--surface-1)',
      ['--node-chrome-active-bg' as any]: chromeTint
        ? `color-mix(in srgb, ${chromeTint.background} 86%, white 14%)`
        : 'var(--surface-3)',
      ['--node-chrome-accent' as any]: chromeTint?.accent ?? 'var(--focus-blue)',
      transition: baseTransition + layoutTransition,
      filter: worktreeDim ? 'saturate(0.4)' : undefined,
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity,
      pointerEvents: isExiting || isWholeNodeDragSource ? 'none' : undefined,
      userSelect: 'none',
    }
  }, [node, isFocused, activityState, isAnimatingLayout, isHovered, chromeTint, isWholeNodeDragSource, worktreeDim])

  const glowStyle = useMemo<React.CSSProperties | null>(() => {
    if (!node) return null
    if (!(isFocused || worktreeHighlight)) return null
    // Hide the focus glow while the node is the drag source — the source node
    // itself is hidden (containerStyle.opacity = 0 above) and the glow would
    // otherwise float at the node's original origin while the ghost moves.
    if (isWholeNodeDragSource) return null
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'
    const layoutTransition = isAnimatingLayout
      ? 'left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1), '
      : ''
    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: 999,
      borderRadius: CORNER_RADIUS,
      // Worktree highlight (hover/lens) → colored ring in the branch color;
      // else focused/active → soft halo.
      boxShadow:
        worktreeHighlight && worktreeColor
          ? `0 0 0 2px ${worktreeColor}, 0 0 18px -2px ${worktreeColor}`
          : FOCUS_GLOW,
      pointerEvents: 'none',
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering || isExiting ? 0 : 1,
      transition: `${layoutTransition}transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out, box-shadow 200ms ease`,
    }
  }, [node, isFocused, isAnimatingLayout, isWholeNodeDragSource, worktreeHighlight, worktreeColor])

  return { containerStyle, glowStyle }
}
