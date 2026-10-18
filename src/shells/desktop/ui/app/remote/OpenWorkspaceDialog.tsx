// The "Open…" picker: a popover under the sidebar's "+" while that shows,
// else a modal; nothing while the page shows the picker itself (the welcome
// page focuses its own). It steps aside while a dialog started from it (a machine's
// folders, joining) is open, and comes back when that one is dismissed.

import { useRef } from 'react'
import { FolderOpen } from 'lucide-react'
import { Modal, PopoverSurface, useDismissableLayer, useViewportPopoverPosition } from '../../kernel/interaction'
import { useUIStore } from '../state/uiStore'
import { WorkspacePicker } from './WorkspacePicker'

/** The element the picker hangs from (the sidebar's "+"). */
export const OPEN_WORKSPACE_ANCHOR = 'data-open-workspace-anchor'

const POPOVER_WIDTH = 260

function shownAnchor(): HTMLElement | null {
  const anchor = document.querySelector<HTMLElement>(`[${OPEN_WORKSPACE_ANCHOR}]`)
  return anchor && anchor.getBoundingClientRect().width > 0 ? anchor : null
}

export function OpenWorkspaceDialog(): JSX.Element | null {
  const open = useUIStore((s) => s.openDialogOpen && !s.pickerOnPage && !s.machineFolder && !s.joinDialog)
  if (!open) return null
  const close = () => useUIStore.getState().closeWorkspacePicker()
  const anchor = shownAnchor()
  if (anchor) return <OpenWorkspacePopover anchor={anchor} close={close} />
  return (
    <Modal onClose={close} width={560} icon={<FolderOpen size={16} />} title="Open a workspace" bodyClassName="min-h-0 flex flex-col p-3">
      <WorkspacePicker autoFocus onPicked={close} listClassName="max-h-[60vh]" />
    </Modal>
  )
}

function OpenWorkspacePopover({ anchor, close }: { anchor: HTMLElement; close: () => void }): JSX.Element {
  const anchorRef = useRef<HTMLElement | null>(anchor)
  anchorRef.current = anchor
  const popoverRef = useRef<HTMLDivElement>(null)
  const { pos, portalTarget } = useViewportPopoverPosition(anchorRef, true, (rect) => ({
    left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)),
    gap: 6,
  }), popoverRef)
  // The "+" toggles the picker itself.
  useDismissableLayer({ open: true, contentRef: popoverRef, triggerRefs: [anchorRef], onDismiss: close })
  return (
    <PopoverSurface popoverRef={popoverRef} pos={pos} portalTarget={portalTarget} width={POPOVER_WIDTH} className="p-2">
      <div role="dialog" aria-label="Open a workspace" className="flex min-h-0 flex-col">
        <WorkspacePicker autoFocus onPicked={close} listClassName="max-h-[50vh]" />
      </div>
    </PopoverSurface>
  )
}
