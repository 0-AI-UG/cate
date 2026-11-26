import { Check, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { Point } from '@workspace/canvas/contract'
import type { PanelRecord, PanelRelation, RelationKind } from '@workspace/document/contract'
import { RELATION_LABEL_MAX, panelRelationLabel, panelRelationOptions, relationPanelOf } from '@workspace/relations/contract'
import { Waypoints } from 'lucide-react'
import { Kbd, ListDialog, inputCls } from '../../kernel/interaction'
import {
  forgetRelationLabel,
  labelRelation,
  moveRelation,
  rememberRelationLabel,
  removeRelation,
  renameRelationLabel,
  updateRelationMeaning,
} from './actions'
import { relationRoleOf, useRelationCanvas, useSavedRelationLabels } from './host'
import { useRelationUi } from './state'

export function PanelRelationSelector({
  workspaceId,
  relation,
  sourcePanel,
  targetPanel,
  position,
  muted = false,
  visible = true,
}: {
  workspaceId: string
  relation: PanelRelation
  sourcePanel: PanelRecord
  targetPanel: PanelRecord
  position: Point
  /** Its flow's prompt context is off: drawn faded until hovered. */
  muted?: boolean
  /** Named while a panel it joins is selected; otherwise only its line is drawn, and clicking that opens the dialog. */
  visible?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editingCustom, setEditingCustom] = useState(false)
  const [editingSavedLabel, setEditingSavedLabel] = useState<string | null>(null)
  const [customLabel, setCustomLabel] = useState(relation.label ?? '')
  const [dragging, setDragging] = useState(false)
  const savedLabels = useSavedRelationLabels()
  const requestedOpen = useRelationUi((state) => state.editingRelationId === relation.id)
  const { canvas: canvasStore } = useRelationCanvas()
  const inputRef = useRef<HTMLInputElement>(null)
  const suppressClickRef = useRef(false)
  const source = relationPanelOf(sourcePanel, relationRoleOf)
  const target = relationPanelOf(targetPanel, relationRoleOf)
  const choices = panelRelationOptions(source, target)

  useEffect(() => {
    if (!requestedOpen) return
    setOpen(true)
    useRelationUi.getState().openRelationEditor(null)
  }, [requestedOpen])

  useEffect(() => {
    setCustomLabel(relation.label ?? '')
  }, [relation.label])

  const close = () => {
    setOpen(false)
    setEditingCustom(false)
    setEditingSavedLabel(null)
    setCustomLabel(relation.label ?? '')
  }

  useEffect(() => {
    if (editingCustom || editingSavedLabel) inputRef.current?.focus()
  }, [editingCustom, editingSavedLabel])

  const choose = (kind: RelationKind) => {
    updateRelationMeaning(workspaceId, relation.id, kind)
    setOpen(false)
  }

  const saveCustom = () => {
    const label = customLabel.trim()
    if (!label) return
    labelRelation(workspaceId, relation.id, label)
    rememberRelationLabel(label)
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
    renameRelationLabel(editingSavedLabel, label)
    // This relation follows the label it has.
    if (relation.label === editingSavedLabel) labelRelation(workspaceId, relation.id, label)
    setEditingSavedLabel(null)
  }

  const chooseSaved = (label: string) => {
    labelRelation(workspaceId, relation.id, label)
    setOpen(false)
  }

  const deleteSaved = (label: string) => {
    forgetRelationLabel(label)
  }

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('[data-panel-relation-chip]') || target.closest('[data-panel-connection-delete]')) return
    event.stopPropagation()
    const start = { x: event.clientX, y: event.clientY }
    const origin = position
    let moved = false
    let last: Point | null = null

    // The chip follows the pointer locally; the waypoint goes to the document
    // as one op when the drag ends.
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
      const zoom = canvasStore?.getState().zoomLevel ?? 1
      last = { x: origin.x + dx / zoom, y: origin.y + dy / zoom }
      useRelationUi.getState().previewWaypoint(relation.id, last)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (last) moveRelation(workspaceId, relation.id, last)
      useRelationUi.getState().previewWaypoint(relation.id, null)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const listRef = useRef<HTMLDivElement>(null)

  // Arrows move focus between rows (Enter then clicks the focused row), digits
  // pick a meaning, C adds a custom one, ⌘⌫ removes the connection. Typing in a
  // field is left alone.
  const onDialogKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-list-row]') ?? [])
      if (rows.length === 0) return
      const index = rows.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      rows[index === -1 ? (step === 1 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length].focus()
      return
    }
    if (event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      removeRelation(workspaceId, relation.id)
      close()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault()
      addCustom()
      return
    }
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
      event.preventDefault()
      choose(choices[digit - 1].kind)
    }
  }

  const collapsed = !visible && !open

  // The chip sits with the connection lines, under the nodes (1000 + zOrder);
  // its dialog is a modal over everything.
  return (
    <div
      data-panel-relation-selector={relation.id}
      className={`pointer-events-auto absolute z-[500] ${dragging ? 'cursor-grabbing' : ''}`}
      style={{ left: position.x, top: position.y, transform: 'translate(-50%, -50%)' }}
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
      {!collapsed && (
      <div data-panel-relation-chip className={`group flex h-[18px] cursor-grab animate-sidebar-view-in items-center justify-center rounded-md bg-surface-1/80 px-2 text-[10px] text-secondary ring-1 ring-white/[0.06] backdrop-blur-md transition-[color,box-shadow,opacity] duration-150 ease-out hover:text-primary hover:ring-white/20 active:cursor-grabbing motion-reduce:animate-none motion-reduce:transition-none${muted && !open ? ' opacity-70 hover:opacity-100' : ''}`}>
        <button
          type="button"
          data-panel-relation-trigger
          aria-haspopup="dialog"
          aria-expanded={open}
          className="min-w-0 outline-none focus-visible:text-focus-blue"
          onClick={() => setOpen(true)}
        >
          <span className="block max-w-36 truncate whitespace-nowrap">
            {panelRelationLabel(relation, source, target)}
          </span>
        </button>
      </div>
      )}

      {open && (
        <ListDialog
          ariaLabel="Connection"
          width={560}
          icon={<Waypoints size={16} />}
          title="Connection"
          subtitle={`${sourcePanel.title} → ${targetPanel.title}`}
          hints={[
            { keys: ['↑', '↓'], label: 'Navigate' },
            { keys: ['Enter'], label: 'Select' },
            { keys: [`1–${choices.length}`], label: 'Pick' },
            { keys: ['C'], label: 'Custom' },
            { keys: ['⌘⌫'], label: 'Remove' },
            { keys: ['Esc'], label: 'Close' },
          ]}
          onClose={close}
          onKeyDown={onDialogKey}
        >
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            <div role="radiogroup" aria-label="Connection meaning" className="pt-1">
              {choices.map((choice, index) => {
                const selected = !relation.label && relation.kind === choice.kind
                return (
                  <button
                    key={choice.kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-list-row
                    className={ROW}
                    onMouseEnter={focusRow}
                    onClick={() => choose(choice.kind)}
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center text-focus-blue">
                      {selected ? <Check size={14} weight="bold" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span>{choice.label}</span>
                        {index === 0 ? <span className="text-[12px] text-muted">Recommended</span> : null}
                      </span>
                      <span className="block truncate text-[12px] text-muted">{choice.description}</span>
                    </span>
                    {index < 9 ? <Kbd>{index + 1}</Kbd> : null}
                  </button>
                )
              })}
            </div>

            {savedLabels.length > 0 ? (
              <>
                <div className="px-3 pb-1 pt-4 text-[13px] font-medium text-muted">Saved relationships</div>
                {savedLabels.map((label) => {
                  const selected = relation.label === label
                  return (
                    <div key={label} className="group/saved flex items-center">
                      {editingSavedLabel === label ? (
                        <form className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1" onSubmit={(event) => { event.preventDefault(); saveSaved() }}>
                          <input
                            ref={inputRef}
                            value={customLabel}
                            maxLength={RELATION_LABEL_MAX}
                            aria-label={`Edit saved relationship ${label}`}
                            className={`${inputCls} select-text`}
                            onChange={(event) => setCustomLabel(event.target.value)}
                          />
                          <button type="submit" aria-label="Save relationship changes" disabled={!customLabel.trim()} className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-focus-blue text-white disabled:opacity-40">
                            <Check size={13} weight="bold" />
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            data-list-row
                            className={`${ROW} min-w-0 flex-1`}
                            onMouseEnter={focusRow}
                            onClick={() => chooseSaved(label)}
                          >
                            <span className="grid h-4 w-4 shrink-0 place-items-center text-focus-blue">
                              {selected ? <Check size={14} weight="bold" /> : null}
                            </span>
                            <span className="truncate">{label}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Edit saved relationship ${label}`}
                            title="Edit saved relationship"
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-hover hover:text-primary focus-visible:opacity-100 group-hover/saved:opacity-100"
                            onClick={() => editSaved(label)}
                          >
                            <PencilSimple size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete saved relationship ${label}`}
                            title="Delete saved relationship"
                            className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted opacity-0 outline-none transition-[opacity,color,background-color] hover:bg-hover hover:text-primary focus-visible:opacity-100 group-hover/saved:opacity-100"
                            onClick={() => deleteSaved(label)}
                          >
                            <Trash size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </>
            ) : null}

            <div className="mt-2 border-t border-white/[0.07] pt-2">
              {editingCustom ? (
                <form className="flex items-center gap-2 px-2 py-1" onSubmit={(event) => { event.preventDefault(); saveCustom() }}>
                  <input
                    ref={inputRef}
                    data-panel-relation-custom-input
                    value={customLabel}
                    maxLength={RELATION_LABEL_MAX}
                    aria-label="Custom connection meaning"
                    placeholder="e.g. summarizes for"
                    className={`${inputCls} select-text`}
                    onChange={(event) => setCustomLabel(event.target.value)}
                  />
                  <button type="submit" aria-label="Save custom meaning" disabled={!customLabel.trim()} className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-focus-blue text-white disabled:opacity-40">
                    <Check size={13} weight="bold" />
                  </button>
                </form>
              ) : (
                <button type="button" data-list-row className={`${ROW} text-secondary`} onMouseEnter={focusRow} onClick={addCustom}>
                  <PencilSimple size={16} className="shrink-0" />
                  <span className="flex-1">Add custom relationship</span>
                  <Kbd>C</Kbd>
                </button>
              )}
              <button
                type="button"
                data-list-row
                data-panel-connection-delete={relation.id}
                className={`${ROW} text-secondary`}
                onMouseEnter={focusRow}
                onClick={() => { removeRelation(workspaceId, relation.id); close() }}
              >
                <X size={16} className="shrink-0" />
                <span className="flex-1">Remove connection</span>
                <Kbd>⌘⌫</Kbd>
              </button>
            </div>
          </div>
        </ListDialog>
      )}
    </div>
  )
}

const ROW = `flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-primary outline-none transition-colors focus:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]`

function focusRow(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.focus({ preventScroll: true })
}
