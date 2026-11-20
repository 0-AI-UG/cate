// =============================================================================
// Modal — the shared dialog primitive for Cate.
//
// One chrome for every modal, derived from the Settings window so they all read
// as one family: an opaque surface-1 card with a hairline border, a black ring,
// and a deep shadow, over a dimmed+blurred backdrop. A tinted header bar
// (surface-0/40 under a border) carries the title, optional actions, and close.
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

/** Dimmed, blurred backdrop shared by every full-screen modal. */
export const BACKDROP = 'bg-black/50 backdrop-blur-sm'

/** The card surface every modal/overlay shares (Settings-window chrome). */
export const CARD_SURFACE =
  'rounded-xl bg-surface-1 border border-subtle ring-1 ring-black/40 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]'

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
    <div className={`fixed inset-0 flex flex-row items-start justify-center gap-2 z-50 ${BACKDROP}`} onClick={onClose}>
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
  children,
}: ModalCardProps) {
  const hasHeader = title != null || icon != null || headerActions != null
  const close = showClose ?? hasHeader
  return (
    <div className={`flex flex-col overflow-hidden ${CARD_SURFACE} ${className}`}>
      {hasHeader && (
        <div className="flex items-center gap-2.5 px-5 h-14 shrink-0 border-b border-subtle bg-surface-0/40">
          {icon && <span className="shrink-0 text-secondary">{icon}</span>}
          <span id={titleId} className="flex-1 text-[15px] font-semibold text-primary truncate">{title}</span>
          {headerActions}
          {close && onClose && (
            <Tooltip label="Close (Esc)">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-6 h-6 -mr-1 rounded-[10px] text-secondary hover:text-primary hover:bg-hover transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
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

  return createPortal(
    <div
      className={`modal-backdrop-in fixed inset-0 flex items-center justify-center ${BACKDROP}`}
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
        className="modal-card-in flex flex-col max-w-[92vw] max-h-[90vh]"
        style={size}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapDialogFocus}
      >
        <ModalCard {...card} titleId={titleId} onClose={onClose} bodyClassName={bodyClassName} className="flex-1 min-h-0" />
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
    <kbd className="pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded px-1 font-sans text-[11px] font-medium leading-none text-primary bg-[color-mix(in_srgb,var(--text-primary)_9%,transparent)]">
      {children}
    </kbd>
  )
}

/** The highlight of the row under the pointer or cursor in a list dialog. */
export const LIST_ROW_HIGHLIGHT = 'bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]'

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
  /** Called for keys pressed anywhere in the dialog (arrows, Enter, digits). */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/** The quiet list dialog: a lightly dimmed backdrop, a card that sits close to
 *  the app's own surfaces, a title row, the list, and a footer of shortcuts.
 *  Used by the workspace picker and the workspace actions. */
export function ListDialog({ onClose, ariaLabel, width = 520, icon, title, subtitle, hints = [], onKeyDown, children }: ListDialogProps) {
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
      className="modal-backdrop-in fixed inset-0 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[6px]"
      style={{ zIndex: order }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className="modal-card-in flex max-h-[72vh] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-white/[0.08] shadow-[inset_0_1px_rgb(255_255_255/0.04),0_24px_72px_-20px_rgb(0_0_0/0.9)]"
        style={{ width, background: 'color-mix(in srgb, var(--surface-1) 82%, transparent)', backdropFilter: 'blur(12px) saturate(1.14)', WebkitBackdropFilter: 'blur(12px) saturate(1.14)' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => { trapDialogFocus(event); onKeyDown?.(event) }}
      >
        <div className="flex shrink-0 items-center gap-2.5 px-5 pb-2 pt-4">
          {icon && <span className="shrink-0 text-muted">{icon}</span>}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-primary">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-[12px] text-[color-mix(in_srgb,var(--text-muted)_85%,transparent)]">{subtitle}</div>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1">{children}</div>
        {hints.length > 0 && (
          <div className="flex shrink-0 flex-nowrap items-center gap-x-3 overflow-hidden whitespace-nowrap border-t border-white/[0.07] bg-white/[0.025] px-5 py-2.5 text-[12px] font-medium text-muted">
            {hints.map((hint) => (
              <span key={hint.label} className="inline-flex shrink-0 items-center gap-1.5">
                <span className="inline-flex items-center gap-1">{hint.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</span>
                {hint.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
