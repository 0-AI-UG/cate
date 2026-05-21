// =============================================================================
// useCanvasNodeStyle — derived inline-style memos for CanvasNode's wrapper
// and its sibling focus-glow layer. Kept as a hook (not a pure helper) so the
// memo identities are stable across renders, matching the original inline
// useMemo calls.
// =============================================================================

import React, { useMemo } from 'react'
import type { CanvasNodeState, NodeActivityState } from '../../shared/types'

const CORNER_RADIUS = 8

const SHADOW_UNFOCUSED = `0 20px 60px -12px rgba(0,0,0,0.35), 0 6px 16px -4px rgba(0,0,0,0.2)`
const SHADOW_HOVERED = `${SHADOW_UNFOCUSED}, 0 0 32px rgba(255,255,255,0.03)`
const FOCUS_GLOW = `0 0 100px 8px rgba(74,158,255,0.09), 0 0 40px rgba(74,158,255,0.07)`

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
  isSelected: boolean
  activityState: NodeActivityState | undefined
  zoomLevel: number
  isAnimatingLayout: boolean
  isHovered: boolean
  chromeTint: { background: string; accent: string } | null
  isWholeNodeDragSource: boolean
}

export function useCanvasNodeStyle(args: StyleArgs) {
  const {
    node,
    isFocused,
    isSelected,
    activityState,
    zoomLevel,
    isAnimatingLayout,
    isHovered,
    chromeTint,
    isWholeNodeDragSource,
  } = args

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }

    const isPulsing = activityState?.type === 'agentWaitingForInput'
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'

    const baseTransition =
      'border-color 150ms ease, box-shadow 200ms ease, outline-color 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out'
    const layoutTransition = isAnimatingLayout
      ? ', left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      : ''

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
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering ? 0 : isExiting ? 0 : isWholeNodeDragSource ? 0 : 1,
      pointerEvents: isExiting || isWholeNodeDragSource ? 'none' : undefined,
      userSelect: 'none',
    }
  }, [node, isFocused, isSelected, activityState, zoomLevel, isAnimatingLayout, isHovered, chromeTint, isWholeNodeDragSource])

  const glowStyle = useMemo<React.CSSProperties | null>(() => {
    if (!node) return null
    if (!(isFocused || isSelected)) return null
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
      boxShadow: FOCUS_GLOW,
      pointerEvents: 'none',
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering || isExiting ? 0 : 1,
      transition: `${layoutTransition}transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out`,
    }
  }, [node, isFocused, isSelected, isAnimatingLayout])

  return { containerStyle, glowStyle }
}
