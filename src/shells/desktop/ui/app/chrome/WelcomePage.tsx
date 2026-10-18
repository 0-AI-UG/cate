// The screen a window shows with no workspace selected (or none at all): an
// empty canvas (its grid) with the Cate logo and the workspace picker right
// on it, so the ways in are one click away, and what is new in this version.
// "Open…" focuses this picker instead of opening a second one.

import { useEffect, useRef } from 'react'
import { ScrollText } from 'lucide-react'
import { CateLogo, CARD_SURFACE } from '../../kernel/interaction'
import { CANVAS_GRID_SIZE } from '@workspace/canvas/contract'
import { useCanvasSetting } from '../../client/layout/canvas'
import { useUIStore } from '../state/uiStore'
import { WorkspacePicker } from '../remote/WorkspacePicker'
import { tryClientApp } from '../app'
import { WHATS_NEW_VIEW } from './WhatsNew'

/** The canvas grid (CanvasGrid) at zoom 1, in the user's grid style. */
const GRID_IMAGE = {
  dots: 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)',
  lines: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
} as const

export function WelcomePage(): JSX.Element {
  const gridStyle = useCanvasSetting('canvasGridStyle')
  const pickerOpen = useUIStore((s) => s.openDialogOpen)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useUIStore.getState().setPickerOnPage(true)
    return () => useUIStore.getState().setPickerOnPage(false)
  }, [])
  useEffect(() => {
    if (!pickerOpen) return
    card.current?.querySelector('input')?.focus()
    useUIStore.getState().closeWorkspacePicker()
  }, [pickerOpen])

  return (
    <div data-welcome className="absolute inset-0 z-10 overflow-hidden bg-canvas-bg">
      {gridStyle !== 'none' && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: GRID_IMAGE[gridStyle], backgroundSize: `${CANVAS_GRID_SIZE}px ${CANVAS_GRID_SIZE}px` }}
        />
      )}
      <div className="relative flex h-full items-center justify-center px-8 py-10">
        <div className="flex max-h-full min-h-0 w-full max-w-md flex-col items-center">
          <CateLogo size={240} className="h-16 w-auto shrink-0 text-primary" aria-label="Cate" />
          <p className="mt-3 shrink-0 text-center text-[15px] text-secondary">An infinite canvas for your terminals, editors and browsers.</p>
          <div ref={card} data-onboarding="welcome-actions" className={`mt-7 flex min-h-0 w-full flex-col p-2 ${CARD_SURFACE}`}>
            <WorkspacePicker autoFocus listClassName="max-h-[40vh]" />
          </div>
          <button
            type="button"
            onClick={() => useUIStore.getState().openOverlay({ view: WHATS_NEW_VIEW })}
            className="mt-5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-secondary hover:bg-hover hover:text-primary"
          >
            <ScrollText size={14} />
            What's new in Cate {tryClientApp()?.version}
          </button>
        </div>
      </div>
    </div>
  )
}
