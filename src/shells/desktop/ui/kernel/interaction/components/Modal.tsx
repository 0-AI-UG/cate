// =============================================================================
// Modal — the shared dialog primitive for Cate.
//
// One quiet chrome for every modal, the same as the list dialogs: a lightly
// translucent surface-1 card with a faint white hairline and a deep shadow over
// a dimmed+blurred backdrop. A compact title row (no bar, no divider) carries
// the title, optional actions, and close.
//
// Two entry points:
//   • <Modal>      — portaled, centered, with backdrop. The default for dialogs.
//   • <ModalCard>  — the bare card (header + body), no portal/backdrop, for
//                    overlays scoped to a region (e.g. the canvas lock that must
//                    not cover the sidebar) and search palettes that bring their
//                    own positioning.
//
// Shared class tokens (BACKDROP, CARD_SURFACE, btn, inputCls, SEGMENT) are
// exported so even hand-rolled overlays match without a component per element.
// =============================================================================

import { useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { isTopDialogLayer, useDialogLayer } from './dialogLayers'
import { Tooltip } from './Tooltip'
import { buttonClassName } from './Button'
import { useMenuNumbers } from './menuNumbers'

/** Dimmed, blurred backdrop shared by every full-screen modal. */
export const BACKDROP = 'bg-black/60 backdrop-blur-[6px]'

/** The card surface every modal/overlay shares (Settings-window chrome). */
export const CARD_SURFACE =
  'rounded-[10px] border border-white/[0.08] bg-surface-1 shadow-[0_16px_48px_-16px_rgb(0_0_0/0.8)]'

/** Where every dialog sits: the top of the card at the same height on screen. */
export const DIALOG_TOP = 'pt-[12vh]'

// Controls mirror the Settings form components (SettingsComponents.tsx): solid
// surface-5 wells, rounded-md, hairline border, focus-blue ring. Kept here as
// class tokens so modal forms match Settings without importing fixed-width
// settings widgets.

/** Button variants used across modal footers and overlay action rows. */
export const btn = {
  primary: buttonClassName('primary'),
  secondary: buttonClassName('secondary'),
  ghost: buttonClassName('ghost'),
  danger: buttonClassName('danger'),
}

/** Form-control surface — the same well Settings inputs use. */
export const inputCls =
  'w-full bg-surface-5 border border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-primary outline-none placeholder:text-muted focus:border-focus-blue transition-colors'

/** Segmented-control container + per-segment classes (active / idle). */
export const SEGMENT = {
  group: 'inline-flex p-0.5 gap-0.5 rounded-md bg-surface-0 border border-subtle',
  seg: (active: boolean): string =>
    `px-3 h-7 rounded text-[12px] font-medium transition-colors ${
      active ? 'bg-surface-5 text-primary shadow-sm' : 'text-muted hover:text-secondary'
    }`,
}

/** Return keyboard focus to wherever it was before this dialog opened. The
 *  active element is captured on the first render — before the dialog's own
 *  autoFocus moves focus — and restored on unmount, but only when focus fell
 *  back to <body> (i.e. the dialog closed without the user deliberately focusing
 *  something else). Without this, closing a dialog/palette leaves focus on
 *  <body> and keyboard shortcuts stop reaching the panel until the user clicks. */
function useRestoreFocusOnUnmount(): void {
  const [previous] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  )
  useEffect(() => {
    return () => {
      const active = document.activeElement
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (active === null || active === document.body)
      ) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [previous])
}

interface PaletteDialogShellProps {
  /** Dismiss when the backdrop (outside the card) is clicked. */
  onClose: () => void
  /** Classes on the inner card (sizing/positioning). CARD_SURFACE is applied. */
  cardClassName: string
  /** Extra props forwarded to the inner card (e.g. data-onboarding). */
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>
  children: ReactNode
  /** Optional detached card rendered as a sibling BELOW the main card (its own
   *  CARD_SURFACE, own stop-propagation), separated by a gap. */
  aside?: ReactNode
  /** Sizing/positioning classes for the aside card. CARD_SURFACE is applied. */
  asideClassName?: string
  /** Accessible name for the palette dialog. */
  ariaLabel?: string
}

const FOCUSABLE = [
  'button:not([disabled])',
  'iframe',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function useDialogFocus(ref: RefObject<HTMLElement | null>, order?: number): void {
  useEffect(() => {
    const dialog = ref.current
    if (!dialog || order !== undefined && !isTopDialogLayer(order)) return
    if (!dialog.contains(document.activeElement)) {
      const initial = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
        ?? dialog.querySelector<HTMLElement>(FOCUSABLE)
        ?? dialog
      initial.focus({ preventScroll: true })
    }
  }, [ref, order])
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => element.getClientRects().length > 0)
  if (focusable.length === 0) {
    event.preventDefault()
    event.currentTarget.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/** Top-anchored palette shell: full-screen dimmed backdrop that closes on an
 *  outside click, wrapping a centered card that stops propagation so clicks
 *  inside don't dismiss. Shared by the Cmd+K palette and palette-style dialogs;
 *  Escape handling stays with each caller. An optional `aside` renders as a
 *  second, detached card beside the main one (the pair is centered as a group). */
export function PaletteDialogShell({
  onClose,
  cardClassName,
  cardProps,
  children,
  aside,
  asideClassName,
  ariaLabel = 'Dialog',
}: PaletteDialogShellProps) {
  useRestoreFocusOnUnmount()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  return (
    <div className={`fixed inset-0 flex flex-row items-start justify-center gap-2 z-50 ${DIALOG_TOP} ${BACKDROP}`} onClick={onClose}>
      <div
        {...cardProps}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`${cardClassName} ${CARD_SURFACE}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapDialogFocus}
      >
        {children}
      </div>
      {aside && (
        <div
          className={`${asideClassName ?? ''} ${CARD_SURFACE}`}
          onClick={(e) => e.stopPropagation()}
        >
          {aside}
        </div>
      )}
    </div>
  )
}

interface ModalCardProps {
  /** Header title. Omit (with no icon/actions) to render a headerless card. */
  title?: ReactNode
  /** Optional leading icon in the header. */
  icon?: ReactNode
  /** Optional controls rendered just left of the close button. */
  headerActions?: ReactNode
  /** Show the header close (X). Defaults to true when a header is present. */
  showClose?: boolean
  onClose?: () => void
  /** Extra classes on the card root (sizing, etc.). */
  className?: string
  /** Classes on the body wrapper. Defaults to a scrollable region. */
  bodyClassName?: string
  children: ReactNode
  /** Internal id used to associate a surrounding dialog with its title. */
  titleId?: string
  /** Keyboard hints for the footer. */
  hints?: readonly DialogHint[]
  /** Shown at the right end of the footer. */
  footer?: ReactNode
}

/** Bare card: shared surface + optional header + body. No portal or backdrop —
 *  the caller positions it. */
export function ModalCard({
  title,
  icon,
  headerActions,
  showClose,
  onClose,
  className = '',
  bodyClassName = 'min-h-0 flex-1 overflow-auto',
  titleId,
  hints = [],
  footer,
  children,
}: ModalCardProps) {
  const hasHeader = title != null || icon != null || headerActions != null
  const close = showClose ?? hasHeader
  return (
    <div className={`flex flex-col overflow-hidden ${CARD_SURFACE} ${className}`}>
      {hasHeader && (
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
          {icon && <span className="shrink-0 text-muted">{icon}</span>}
          <span id={titleId} className="flex-1 text-[13.5px] font-medium text-primary truncate">{title}</span>
          {headerActions}
          {close && onClose && (
            <Tooltip label="Close (Esc)">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-5 h-5 -mr-1 rounded-md text-muted hover:text-primary hover:bg-hover transition-colors"
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
      <DialogFooter hints={hints} footer={footer} />
    </div>
  )
}

interface ModalProps extends Omit<ModalCardProps, 'onClose' | 'className'> {
  onClose: () => void
  /** Card width (px number or CSS string). */
  width?: number | string
  /** Optional fixed card height (px number or CSS string). */
  height?: number | string
  /** Allow a backdrop click to dismiss. Defaults to true. */
  dismissable?: boolean
  /** Close on Escape. Defaults to `dismissable`. Set false when the caller owns
   *  Escape (e.g. to clear a search before closing). */
  closeOnEscape?: boolean
  /** Rows marked `data-menu-item` get 1-9 badges and pick on the digit. */
  numbered?: boolean
}

/** Portaled, centered modal: dimmed blurred backdrop + entrance + the shared
 *  card. Closes on Escape and backdrop click unless `dismissable={false}`. */
export function Modal({
  onClose,
  width = 360,
  height,
  dismissable = true,
  closeOnEscape,
  bodyClassName,
  numbered = false,
  hints,
  ...card
}: ModalProps) {
  useRestoreFocusOnUnmount()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const escapeCloses = closeOnEscape ?? dismissable
  const order = useDialogLayer((event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (escapeCloses) onClose()
  })

  useDialogFocus(dialogRef, order)

  const size: CSSProperties = { width, ...(height != null ? { height } : null) }
  useMenuNumbers(dialogRef, numbered)
  const footerHints = hints ?? [
    ...(numbered ? [{ keys: ['1–9'], label: 'Pick' }] : []),
    ...(escapeCloses ? [{ keys: ['Esc'], label: 'Close' }] : []),
  ]

  return createPortal(
    <div
      className={`modal-backdrop-in fixed inset-0 flex items-start justify-center ${DIALOG_TOP} ${BACKDROP}`}
      style={{ zIndex: order }}
      onClick={dismissable ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={card.title != null ? titleId : undefined}
        aria-label={card.title == null ? 'Dialog' : undefined}
        tabIndex={-1}
        className="modal-card-in flex flex-col max-w-[92vw] max-h-[76vh]"
        style={size}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapDialogFocus}
      >
        <ModalCard {...card} titleId={titleId} onClose={onClose} bodyClassName={bodyClassName} hints={footerHints} className="flex-1 min-h-0" />
      </div>
    </div>,
    document.body,
  )
}

/** One keyboard hint in a dialog footer: its keys and what they do. */
export interface DialogHint { keys: readonly string[]; label: string }

/** A key cap: a quiet tinted chip, no border. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-[18px] min-w-[18px] select-none items-center justify-center rounded px-1 font-sans text-[10.5px] font-medium leading-none text-primary bg-[color-mix(in_srgb,var(--text-primary)_9%,transparent)]">
      {children}
    </kbd>
  )
}

/** The highlight of the row under the pointer or cursor in a list dialog. */
export const LIST_ROW_HIGHLIGHT = 'bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]'

/** The footer every dialog shares: key hints on the left, an optional note on the right. */
export function DialogFooter({ hints = [], footer }: { hints?: readonly DialogHint[]; footer?: ReactNode }) {
  if (hints.length === 0 && !footer) return null
  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-x-3 overflow-hidden whitespace-nowrap border-t border-white/[0.07] bg-white/[0.025] px-4 py-1.5 text-[11.5px] font-medium text-muted">
      {hints.map((hint) => (
        <span key={hint.label} className="inline-flex shrink-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1">{hint.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</span>
          {hint.label}
        </span>
      ))}
      {footer && <span className="ml-auto shrink-0">{footer}</span>}
    </div>
  )
}

interface ListDialogProps {
  onClose: () => void
  ariaLabel: string
  /** Card width in px. */
  width?: number
  /** Title row above the list. */
  icon?: ReactNode
  title: ReactNode
  /** Smaller line under the title. */
  subtitle?: ReactNode
  /** Keyboard hints shown in the footer. */
  hints?: readonly DialogHint[]
  /** A fixed card height (px number or CSS string), for lists that load. */
  height?: number | string
  /** Shown at the right end of the footer. */
  footer?: ReactNode
  /** Called for keys pressed anywhere in the dialog (arrows, Enter, digits). */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/** The quiet list dialog: a dimmed backdrop, a solid card in the app's own surface, a title row, the list, and a footer of shortcuts.
 *  Used by the workspace picker and the workspace actions. */
export function ListDialog({ onClose, ariaLabel, width = 520, height, icon, title, subtitle, hints = [], footer, onKeyDown, children }: ListDialogProps) {
  useRestoreFocusOnUnmount()
  const dialogRef = useRef<HTMLDivElement>(null)
  const order = useDialogLayer((event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    onClose()
  })
  useDialogFocus(dialogRef, order)
  return createPortal(
    <div
      className={`modal-backdrop-in fixed inset-0 flex items-start justify-center ${DIALOG_TOP} ${BACKDROP}`}
      style={{ zIndex: order }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`modal-card-in flex max-h-[76vh] max-w-[92vw] flex-col overflow-hidden ${CARD_SURFACE}`}
        style={{ width, ...(height != null ? { height } : null) }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => { trapDialogFocus(event); onKeyDown?.(event) }}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
          {icon && <span className="shrink-0 text-muted">{icon}</span>}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-primary">{title}</div>
            {subtitle && <div className="truncate text-[11.5px] text-[color-mix(in_srgb,var(--text-muted)_85%,transparent)]">{subtitle}</div>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-1.5 pt-0.5">{children}</div>
        <DialogFooter hints={hints} footer={footer} />
      </div>
    </div>,
    document.body,
  )
}
