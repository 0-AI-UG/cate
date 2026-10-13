// The screen a window shows with no workspace selected (or none at all): an
// empty canvas (its grid) with the Cate logo, the ways in
// (the Open picker, joining with a code), what is new in this version as a
// panel on it, and the shortcuts worth knowing. It fits the window: only the
// changelog scrolls.

import { FolderOpen, KeyRound } from 'lucide-react'
import { Button, useDeclaredActions, useResolvedShortcuts } from '../../kernel/interaction'
import { canRunAction } from '@client/host'
import { useActionsVersion } from '../../client/host/hooks'
import { displayString } from '@kernel/interaction/contract'
import { CANVAS_GRID_SIZE } from '@workspace/canvas/contract'
import { useCanvasSetting } from '../../client/layout/canvas'
import { useUIStore } from '../state/uiStore'
import { CateLogo } from './CateLogo'
import { WhatsNew } from './WhatsNew'

/** The canvas grid (CanvasGrid) at zoom 1, in the user's grid style. */
const GRID_IMAGE = {
  dots: 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)',
  lines: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
} as const

export function WelcomePage(): JSX.Element {
  const shortcuts = useResolvedShortcuts()
  useActionsVersion()
  const welcome = useDeclaredActions().filter(({ id, spec }) => spec.welcome && canRunAction(id, { workspaceId: null }))
  const gridStyle = useCanvasSetting('canvasGridStyle')
  const openKey = shortcuts.openWorkspace?.key ? displayString(shortcuts.openWorkspace) : null

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
        <div className="flex max-h-full min-h-0 w-full max-w-2xl flex-col items-center">
          <CateLogo size={240} className="h-16 w-auto shrink-0 text-primary" aria-label="Cate" />
          <p className="mt-3 shrink-0 text-[15px] text-secondary">An infinite canvas for your terminals, editors and browsers.</p>

          <div data-onboarding="welcome-actions" className="mt-7 flex shrink-0 items-center gap-2">
            <Button variant="primary" className="h-10 gap-2 rounded-lg px-4 text-[14px]" onClick={() => useUIStore.getState().setOpenDialogOpen(true)}>
              <FolderOpen size={15} />
              Open a workspace
              {openKey && <kbd className="ml-1 font-sans text-[12px] opacity-70">{openKey}</kbd>}
            </Button>
            <Button variant="ghost" className="h-10 gap-2 rounded-lg px-4 text-[14px]" onClick={() => useUIStore.getState().openJoinDialog()}>
              <KeyRound size={15} />
              Join with a code
            </Button>
          </div>

          <WhatsNew className="mt-10 min-h-0 w-full" />

          <ul aria-label="Keyboard shortcuts" className="mt-6 flex shrink-0 flex-wrap justify-center gap-x-5 gap-y-2">
            {welcome.filter(({ id }) => id !== 'openWorkspace' && shortcuts[id]?.key).map(({ id, spec }) => (
              <li key={id} className="flex items-center gap-2 text-[12px] text-muted">
                <kbd className="rounded border border-strong bg-surface-0 px-1.5 py-px font-sans text-[11px] text-secondary">{displayString(shortcuts[id])}</kbd>
                {spec.title}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
