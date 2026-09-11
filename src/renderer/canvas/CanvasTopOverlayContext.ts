import { createContext, useContext } from 'react'

// Browser panels in the main window live in a persistent, fixed host outside
// the transformed canvas. Canvas chrome that must paint above every panel is
// portalled into this screen-level layer so it can cross that stacking boundary.
export const CanvasTopOverlayContext = createContext<HTMLElement | null>(null)

export function useCanvasTopOverlayTarget(): HTMLElement | null {
  return useContext(CanvasTopOverlayContext)
}

// Relation controls need their own high stacking context above persistent
// browser surfaces. `undefined` means no Canvas provider (primarily tests),
// while `null` means the portal host has not mounted yet.
export const CanvasRelationOverlayContext = createContext<HTMLElement | null | undefined>(undefined)

export function useCanvasRelationOverlayTarget(): HTMLElement | null | undefined {
  return useContext(CanvasRelationOverlayContext)
}
