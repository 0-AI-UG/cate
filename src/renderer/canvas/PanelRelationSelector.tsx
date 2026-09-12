import { Check, CaretDown, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  PANEL_RELATION_LABELS,
  PANEL_RELATION_DESCRIPTIONS,
  panelRelationKindsForTarget,
  panelRelationLabel,
  type PanelRelation,
  type PanelRelationKind,
} from '../../shared/panelRelations'
import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useCanvasRelationOverlayTarget } from './CanvasTopOverlayContext'

function RelationMenuPortal({ target, position, children }: {
  target: HTMLElement | null | undefined
  position: { x: number; y: number }
  children: ReactNode
}) {
  if (!target) return children
  return createPortal(
    <div
      data-panel-relation-menu-portal
      className="pointer-events-auto absolute z-[100001]"
      style={{
        left: position.x,
        top: position.y + 16,
        transform: 'translateX(-50%) scale(0.96)',
      }}
    >
      {children}
    </div>,
    target,
  )
}

export function PanelRelationSelector({
  workspaceId,
  relation,
  targetPanel,
  position,
}: {
  workspaceId: string
  relation: PanelRelation
  targetPanel: PanelState
  position: { x: number; y: number }
}) {
  const [open, setOpen] = useState(false)
  const [editingCustom, setEditingCustom] = useState(false)
  const [editingSavedLabel, setEditingSavedLabel] = useState<string | null>(null)
  const [customLabel, setCustomLabel] = useState(relation.label ?? '')
  const [dragging, setDragging] = useState(false)
  const savedLabels = useSettingsStore((state) => state.savedPanelRelationLabels)
  const requestedOpen = useUIStore((state) => state.editingPanelRelationId === relation.id)
  const relationOverlayTarget = useCanvasRelationOverlayTarget()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const suppressClickRef = useRef(false)
  const canvasStore = useCanvasStoreApi()
  const relevantChoices = panelRelationKindsForTarget(targetPanel)
  const choices = relevantChoices.includes(relation.kind)
    ? relevantChoices
    : [...relevantChoices, relation.kind]

  useEffect(() => {
    if (!requestedOpen) return
    setOpen(true)
    useUIStore.getState().openPanelRelationEditor(null)
  }, [requestedOpen])

  useEffect(() => {
    setCustomLabel(relation.label ?? '')
  }, [relation.label])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
        setEditingCustom(false)
        setEditingSavedLabel(null)
        setCustomLabel(relation.label ?? '')
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!editingCustom && !editingSavedLabel) setOpen(false)
      setEditingCustom(false)
      setEditingSavedLabel(null)
      setCustomLabel(relation.label ?? '')
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [editingCustom, editingSavedLabel, open, relation.label])

  useEffect(() => {
    if (editingCustom || editingSavedLabel) inputRef.current?.focus()
  }, [editingCustom, editingSavedLabel])

  const choose = (kind: PanelRelationKind) => {
    useAppStore.getState().updatePanelRelation(workspaceId, relation.id, kind)
    setOpen(false)
  }

  const saveCustom = () => {
    const label = customLabel.trim()
    if (!label) return
    useAppStore.getState().updatePanelRelation(workspaceId, relation.id, relation.kind, label)
    useSettingsStore.getState().setSetting('savedPanelRelationLabels', [
      label,
      ...useSettingsStore.getState().savedPanelRelationLabels.filter(
        (saved) => saved.toLocaleLowerCase() !== label.toLocaleLowerCase(),
      ),
    ])
    setOpen(false)
    setEditingCustom(false)
  }

  const addCustom = () => {
    setCustomLabel('')
    setEditingSavedLabel(null)
    setEditingCustom(true)
  }

  const editSaved = (label: string) => {
    setCustomLabel(label)
    setEditingCustom(false)
    setEditingSavedLabel(label)
  }

  const saveSaved = () => {
    const label = customLabel.trim()
    if (!label || !editingSavedLabel) return
    const renamed = useSettingsStore.getState().savedPanelRelationLabels
      .map((saved) => saved === editingSavedLabel ? label : saved)
      .filter((saved, index, labels) => labels.findIndex(
        (candidate) => candidate.toLocaleLowerCase() === saved.toLocaleLowerCase(),
      ) === index)
    useSettingsStore.getState().setSetting('savedPanelRelationLabels', renamed)
    if (relation.label === editingSavedLabel) {
      useAppStore.getState().updatePanelRelation(workspaceId, relation.id, relation.kind, label)
    }
    setEditingSavedLabel(null)
  }

  const chooseSaved = (label: string) => {
    useAppStore.getState().updatePanelRelation(workspaceId, relation.id, relation.kind, label)
    setOpen(false)
  }

  const deleteSaved = (label: string) => {
    useSettingsStore.getState().setSetting(
      'savedPanelRelationLabels',
      useSettingsStore.getState().savedPanelRelationLabels.filter((saved) => saved !== label),
    )
  }

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('[data-panel-relation-chip]') || target.closest('[data-panel-connection-delete]')) return
    event.stopPropagation()
    const start = { x: event.clientX, y: event.clientY }
    const origin = position
    let moved = false

    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.x
      const dy = moveEvent.clientY - start.y
      if (!moved && Math.hypot(dx, dy) < 3) return
      if (!moved) {
        moved = true
        suppressClickRef.current = true
        setDragging(true)
        setOpen(false)
      }
      const zoom = canvasStore.getState().zoomLevel
      useAppStore.getState().movePanelRelation(workspaceId, relation.id, {
        x: origin.x + dx / zoom,
        y: origin.y + dy / zoom,
      })
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  return (
    <div
      ref={rootRef}
      data-panel-relation-selector={relation.id}
      className={`pointer-events-auto absolute z-[100001] ${dragging ? 'cursor-grabbing' : ''}`}
      style={{ left: position.x, top: position.y, transform: 'translate(-50%, -50%) scale(0.96)' }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={beginDrag}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return
        suppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div data-panel-relation-chip className="group flex h-[22px] cursor-grab animate-sidebar-view-in items-center rounded-full border border-subtle bg-surface-3/95 pl-2 pr-0.5 text-[10px] text-primary shadow-md backdrop-blur-md transition-[border-color,box-shadow,transform] duration-200 ease-out hover:border-focus hover:shadow-lg active:cursor-grabbing motion-reduce:animate-none motion-reduce:transition-none">
        <button
          type="button"
          data-panel-relation-trigger
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 outline-none focus-visible:text-focus-blue"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="max-w-36 truncate whitespace-nowrap">{panelRelationLabel(relation)}</span>
          <CaretDown
            size={9}
            weight="bold"
            className={`shrink-0 text-secondary transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <button
          type="button"
          data-panel-connection-delete={relation.id}
          aria-label="Remove connection"
          className="grid h-[18px] w-[18px] place-items-center rounded-full text-secondary opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-hover hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          onClick={() => useAppStore.getState().removePanelRelation(workspaceId, relation.id)}
        >
          <X size={9} weight="bold" />
        </button>
      </div>

      <RelationMenuPortal target={relationOverlayTarget} position={position}>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Connection meaning"
        aria-hidden={!open}
        className={`${relationOverlayTarget ? 'relative' : 'absolute left-1/2 top-[27px] -translate-x-1/2'} w-56 rounded-lg border border-subtle bg-surface-3/95 p-1 text-[11px] shadow-xl backdrop-blur-xl transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none ${
          open
            ? 'visible translate-y-0 scale-100 opacity-100'
            : 'invisible -translate-y-1 scale-[0.98] opacity-0'
        }`}
      >
        {choices.map((kind, index) => {
          const selected = !relation.label && relation.kind === kind
          return (
            <button
              key={kind}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={open ? 0 : -1}
              className="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left text-primary outline-none transition-colors duration-100 hover:bg-hover focus-visible:bg-hover motion-reduce:transition-none"
              onClick={() => choose(kind)}
            >
              <span className="mt-px grid h-3.5 w-3.5 shrink-0 place-items-center text-focus-blue">
                {selected ? <Check size={11} weight="bold" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span>{PANEL_RELATION_LABELS[kind]}</span>
                  {index === 0 ? <span className="text-[8px] text-muted">Recommended</span> : null}
                </span>
                <span className="block truncate text-[9px] leading-3 text-muted">
                  {PANEL_RELATION_DESCRIPTIONS[kind]}
                </span>
              </span>
            </button>
          )
        })}
        {savedLabels.length > 0 ? (
          <>
            <div className="my-1 h-px bg-surface-border" />
            <div className="px-2 pb-1 pt-0.5 text-[9px] font-medium uppercase tracking-wide text-muted">
              Saved relationships
            </div>
            <div className="max-h-36 overflow-y-auto">
              {savedLabels.map((label) => {
                const selected = relation.label === label
                return (
                  <div key={label} className="group/saved flex items-center rounded-md hover:bg-hover focus-within:bg-hover">
                    {editingSavedLabel === label ? (
                      <form className="flex min-w-0 flex-1 items-center gap-1 p-0.5" onSubmit={(event) => { event.preventDefault(); saveSaved() }}>
                        <input
                          ref={inputRef}
                          value={customLabel}
                          maxLength={80}
                          aria-label={`Edit saved relationship ${label}`}
                          className="h-7 min-w-0 flex-1 select-text rounded-md border border-subtle bg-surface-2 px-2 text-primary outline-none focus:border-focus focus:ring-1 focus:ring-focus-blue/30"
                          onChange={(event) => setCustomLabel(event.target.value)}
                        />
                        <button
                          type="submit"
                          aria-label="Save relationship changes"
                          disabled={!customLabel.trim()}
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-focus-blue text-white disabled:opacity-40"
                        >
                          <Check size={11} weight="bold" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          tabIndex={open ? 0 : -1}
                          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-primary outline-none"
                          onClick={() => chooseSaved(label)}
                        >
                          <span className="grid h-3.5 w-3.5 shrink-0 place-items-center text-focus-blue">
                            {selected ? <Check size={11} weight="bold" /> : null}
                          </span>
                          <span className="truncate">{label}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit saved relationship ${label}`}
                          title="Edit saved relationship"
                          tabIndex={open ? 0 : -1}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-surface-2 hover:text-primary focus-visible:opacity-100 group-hover/saved:opacity-100"
                          onClick={() => editSaved(label)}
                        >
                          <PencilSimple size={11} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete saved relationship ${label}`}
                          title="Delete saved relationship"
                          tabIndex={open ? 0 : -1}
                          className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-surface-2 hover:text-primary focus-visible:opacity-100 group-hover/saved:opacity-100"
                          onClick={() => deleteSaved(label)}
                        >
                          <Trash size={11} />
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        ) : null}
        <div className="my-1 h-px bg-surface-border" />
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${editingCustom ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <form className="overflow-hidden" onSubmit={(event) => { event.preventDefault(); saveCustom() }}>
            <div className="flex items-center gap-1 p-0.5">
              <input
                ref={inputRef}
                data-panel-relation-custom-input
                value={customLabel}
                tabIndex={open && editingCustom ? 0 : -1}
                maxLength={80}
                aria-label="Custom connection meaning"
                placeholder="e.g. summarizes for"
                className="h-7 min-w-0 flex-1 select-text rounded-md border border-subtle bg-surface-2 px-2 text-primary outline-none placeholder:text-muted focus:border-focus focus:ring-1 focus:ring-focus-blue/30"
                onChange={(event) => setCustomLabel(event.target.value)}
              />
              <button
                type="submit"
                aria-label="Save custom meaning"
                tabIndex={open && editingCustom ? 0 : -1}
                disabled={!customLabel.trim()}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-focus-blue text-white disabled:opacity-40"
              >
                <Check size={12} weight="bold" />
              </button>
            </div>
          </form>
        </div>
        <button
          type="button"
          role="menuitem"
          tabIndex={open ? 0 : -1}
          className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-primary outline-none hover:bg-hover focus-visible:bg-hover"
          onClick={addCustom}
        >
          <PencilSimple size={11} className="mr-1.5 shrink-0 text-secondary" />
          Add custom relationship
        </button>
      </div>
      </RelationMenuPortal>
    </div>
  )
}
