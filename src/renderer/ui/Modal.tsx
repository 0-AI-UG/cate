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

import { useEffect, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import { Tooltip } from './Tooltip'

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
  primary:
    'inline-flex items-center justify-center gap-1.5 h-8 px-3.5 rounded-md text-[13px] font-medium bg-focus-blue text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default',
  secondary:
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium border border-subtle text-secondary hover:text-primary hover:bg-hover transition-colors disabled:opacity-40 disabled:cursor-default',
  ghost:
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13px] text-secondary hover:text-primary transition-colors disabled:opacity-40',
  danger:
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13px] text-muted hover:text-red-400 transition-colors disabled:opacity-40',
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

interface PaletteDialogShellProps {
  /** Dismiss when the backdrop (outside the card) is clicked. */
  onClose: () => void
  /** Classes on the inner card (sizing/positioning). CARD_SURFACE is applied. */
  cardClassName: string
  /** Extra props forwarded to the inner card (e.g. data-onboarding). */
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>
  children: ReactNode
}

/** Top-anchored palette shell: full-screen dimmed backdrop that closes on an
 *  outside click, wrapping a centered card that stops propagation so clicks
 *  inside don't dismiss. Shared by the Cmd+K palette and palette-style dialogs;
 *  Escape handling stays with each caller. */
export function PaletteDialogShell({
  onClose,
  cardClassName,
  cardProps,
  children,
}: PaletteDialogShellProps) {
  return (
    <div className={`fixed inset-0 flex justify-center z-50 ${BACKDROP}`} onClick={onClose}>
      <div
        {...cardProps}
        className={`${cardClassName} ${CARD_SURFACE}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
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
  children,
}: ModalCardProps) {
  const hasHeader = title != null || icon != null || headerActions != null
  const close = showClose ?? hasHeader
  return (
    <div className={`flex flex-col overflow-hidden ${CARD_SURFACE} ${className}`}>
      {hasHeader && (
        <div className="flex items-center gap-2.5 px-5 h-14 shrink-0 border-b border-subtle bg-surface-0/40">
          {icon && <span className="shrink-0 text-secondary">{icon}</span>}
          <span className="flex-1 text-[15px] font-semibold text-primary truncate">{title}</span>
          {headerActions}
          {close && onClose && (
            <Tooltip label="Close (Esc)">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-6 h-6 -mr-1 rounded-md text-secondary hover:text-primary hover:bg-hover transition-colors"
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
  /** Stacking class (Settings sits above other modals). */
  zClassName?: string
}

/** Portaled, centered modal: dimmed blurred backdrop + entrance + the shared
 *  card. Closes on Escape and backdrop click unless `dismissable={false}`. */
export function Modal({
  onClose,
  width = 360,
  height,
  dismissable = true,
  closeOnEscape,
  zClassName = 'z-[100000]',
  bodyClassName,
  ...card
}: ModalProps) {
  const escapeCloses = closeOnEscape ?? dismissable
  useEffect(() => {
    if (!escapeCloses) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose, escapeCloses])

  const size: CSSProperties = { width, ...(height != null ? { height } : null) }

  return createPortal(
    <div
      className={`modal-backdrop-in fixed inset-0 ${zClassName} flex items-center justify-center ${BACKDROP}`}
      onClick={dismissable ? onClose : undefined}
    >
      <div
        className="modal-card-in flex flex-col max-w-[92vw] max-h-[90vh]"
        style={size}
        onClick={(e) => e.stopPropagation()}
      >
        <ModalCard {...card} onClose={onClose} bodyClassName={bodyClassName} className="flex-1 min-h-0" />
      </div>
    </div>,
    document.body,
  )
}
