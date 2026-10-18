// The tab strip of a window: panels and layouts in one row, like a browser's
// tabs and tab groups. A layout holding one panel is a plain tab; a layout
// holding several is a group: an anchor chip (the layout as a whole: click
// shows it, right-click renames, moves or closes it) and a container around
// the chips of its panels. A panel chip shows its layout with that panel
// focused; the + opens a new tab. It switches what this client shows of the
// window, never a panel.

import React, { useEffect, useRef } from 'react'
import { Columns2 as Columns, X } from 'lucide-react'
import { dockPanels, type DockLayout, type DocWindow, type LayoutId, type PanelRecord } from '@workspace/document/contract'
import { documentStoreFor } from '@client/document'
import { activeTabOf, closePanel, createPanel, panelDefinition, revealOnce, switchLayout } from '@client/host'
import { canvasOf, placementOf } from '@workspace/document/contract'
import { Tooltip } from '../../../kernel/interaction'
import { useClientState, useDocument } from '../../document'
import { TabIcon } from '../dock/DockTabBar'
import { useTabDecorations } from '../dock/decorations'
import { canSplitLayout } from '../dock/sizing'
import { isMiddleClick } from '../drag/dom'
import { DropGhostChip, NewTabButton, TabTitle, newTabItems } from '../dock'
import { splitStackRight } from '../dock/useDockTabActions'
import { GHOST_LOOK } from '../drag/ghostLook'
import { registerDropZone, type StripTarget } from '../drag/registry'
import type { DragSource, DropTarget } from '../drag/types'
import { useDragStore } from '../drag/store'
import { useDragOp } from '../drag/useDragOp'
import { useDragSettled } from '../drag/settled'
import { closeLayout } from './closeLayout'
import { LayoutGlyph } from './LayoutGlyph'
import { showLayoutMenu } from './layoutMenu'
import { useLayoutRename, usePanelRename } from './useLayoutRename'
import { showPanelMenu } from './panelMenu'
import { buildStripModel, type GapSpot, type StripItemGeom, type StripModel, type StripSource } from './stripModel'

const CHIP = 'group relative flex items-center gap-1.5 whitespace-nowrap cursor-pointer select-none min-w-0 shrink rounded-[var(--node-tab-radius,10px)] h-6 max-w-[200px] pl-2.5 pr-1 text-[12px] transition-colors'
/** A member of a group: a flat segment, the group's capsule clips the ends. */
const SEGMENT = CHIP.replace('rounded-[var(--node-tab-radius,10px)]', 'rounded-none')
const chipTone = (active: boolean) => (active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover')
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function CloseButton({ label, active, onClose, hidden = false }: { label: string; active: boolean; onClose: () => void; hidden?: boolean }) {
  return (
    <Tooltip label={label}>
      <span
        role="button"
        aria-label={label}
        className={`${hidden ? 'invisible ' : ''}shrink-0 p-0.5 rounded-md text-muted hover:text-red-400 hover:bg-hover cursor-pointer transition-opacity ${active ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClose() }}
      >
        <X size={11} />
      </span>
    </Tooltip>
  )
}

export function WindowHeader({ workspaceId, window, activeLayoutId, leadingInset, floating }: {
  workspaceId: string
  window: DocWindow
  activeLayoutId: LayoutId
  /** Space the chips leave at the left for window chrome (traffic lights). */
  leadingInset?: number
  /** Over the view, with no band of its own (a shown canvas shows its grid behind). */
  floating?: boolean
}) {
  const rename = useLayoutRename(workspaceId)
  const panelRename = usePanelRename(workspaceId)
  const windowId = window.id
  const host = { windowId }
  const panels = useDocument(workspaceId, (doc) => doc.panels)
  const worktrees = useDocument(workspaceId, (doc) => doc.worktrees)
  // Several worktrees: a panel's title takes its worktree's color, as in a tab bar.
  const tintWorktrees = Object.keys(worktrees).length >= 2
  const focusedPanel = useClientState(workspaceId, (s) => s.focusedPanelId)
  // Focus inside a canvas node is focus on the canvas chip that draws it.
  const focused = useDocument(workspaceId, (doc) => {
    const canvasId = focusedPanel ? canvasOf(doc, focusedPanel) : null
    if (!canvasId) return focusedPanel
    return window.layouts.flatMap((l) => dockPanels(l.dock)).find((id) => doc.panels[id]?.canvasId === canvasId) ?? focusedPanel
  })
  const activeTabs = useClientState(workspaceId, (s) => s.activeTabs)
  const decorations = useTabDecorations(workspaceId)
  const { handleDragStart, wasDragged } = useDragOp()

  // --- Drag: chips are sources, the strip is a drop zone -------------------------------
  const headerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef(new Map<LayoutId, HTMLElement>())
  const chipRefs = useRef(new Map<string, HTMLElement>())
  const dragSource = useDragStore((s) => (s.isDragging ? s.source : null))
  const dragTarget = useDragStore((s) => s.target)
  const dragCursorX = useDragStore((s) => s.cursor?.client.x ?? 0)
  const dragTitle = useDragStore((s) => s.panel?.title ?? '')
  // The dragged panel's chip (or layout's group) in this strip is the ghost, wherever the drag began. A drag that
  // began on the sidebar's tree leaves it standing until the cursor is over the strip.
  const fromTree = dragSource?.from === 'sidebar'
  const dragPanelId = dragSource?.origin.kind === 'dock-tab' && window.layouts.some((l) => dockPanels(l.dock).includes(dragSource.panelId)) ? dragSource.panelId : null
  const dragLayoutId = dragSource?.origin.kind === 'layout' ? dragSource.origin.layoutId : null
  const liftedLayoutId = dragLayoutId && window.layouts.some((l) => l.id === dragLayoutId) ? dragLayoutId : null
  // The cursor is over this strip: the dragged chip floats along it and the strip makes a gap.
  const stripTarget = dragTarget ? stripTargetOf(dragTarget) : null
  // A tree's target (`via: 'tree'`) is not the strip's, though it is a tab slot of this window.
  const inStrip = !!dragTarget && !!stripTarget && 'workspaceId' in dragTarget && dragTarget.workspaceId === workspaceId
    && !('via' in dragTarget && dragTarget.via)
    && (dragTarget.kind !== 'tab-slot' || (!('canvasId' in dragTarget.host) && dragTarget.host.windowId === windowId))
  // Neighbours slide only once the drag has settled: the dragged chip leaves the
  // row and its gap opens in the same frame, with no motion.
  const armed = useDragSettled()

  /** The layouts, tabs and chips of the strip as drawn now. */
  const measureStrip = (): StripItemGeom[] => {
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const rect = (el: Element | null | undefined) => el?.getBoundingClientRect()
    return window.layouts.flatMap((layout) => {
      const itemEl = itemRefs.current.get(layout.id)
      const item = rect(itemEl)
      if (!item) return []
      const ids = dockPanels(layout.dock)
      const anchor = rect(itemEl?.querySelector('[data-layout-id]'))
      const chips = ids.length > 1 ? ids.flatMap((id) => {
        const chip = rect(chipRefs.current.get(id))
        const placement = doc && placementOf(doc, id)
        return chip && placement ? [{ panelId: id, stackId: placement.stackId, left: chip.left, right: chip.right }] : []
      }) : []
      return [{
        layoutId: layout.id,
        left: item.left,
        right: item.right,
        top: item.top,
        ...(ids.length === 1 ? { panelId: ids[0] } : {}),
        ...(ids.length > 1 && anchor ? { anchor: { left: anchor.left, right: anchor.right } } : {}),
        chips,
      }]
    })
  }
  // One model per drag, built from the strip as it stood when the button went
  // down: by the time the cursor reaches the strip (a drag that starts on a
  // pane's grip) the dragged chip is already collapsed or replaced by its ghost.
  const measureNow = useRef(measureStrip)
  measureNow.current = measureStrip
  const pressedRef = useRef<StripItemGeom[] | null>(null)
  // The + as it stood then too: the lifted chip leaves the strip, and the + with it.
  const pressedPlusRef = useRef<number | null>(null)
  const plusLeft = () => {
    const plus = headerRef.current?.querySelector('[aria-label="New Tab"]')?.getBoundingClientRect()
    return plus && plus.width > 0 ? plus.left : null
  }
  const plusLeftNow = useRef(plusLeft)
  plusLeftNow.current = plusLeft
  useEffect(() => {
    const press = () => { pressedRef.current = measureNow.current(); pressedPlusRef.current = plusLeftNow.current() }
    globalThis.addEventListener('mousedown', press, true)
    return () => globalThis.removeEventListener('mousedown', press, true)
  }, [])
  const modelRef = useRef<{ source: DragSource; model: StripModel } | null>(null)
  const resolveRef = useRef<(cursorX: number, source: DragSource) => StripTarget | null>(() => null)
  resolveRef.current = (cursorX, source) => {
    if (modelRef.current?.source !== source) {
      const origin = source.origin
      // The strip's own chip or group of the dragged panel or layout is lifted ('' is no layout).
      const layoutHere = origin.kind === 'layout' && window.layouts.some((l) => l.id === origin.layoutId)
      const panelHere = origin.kind === 'dock-tab' && window.layouts.some((l) => dockPanels(l.dock).includes(source.panelId))
      const stripSource: StripSource = origin.kind === 'layout' ? { kind: 'layout', layoutId: layoutHere ? origin.layoutId : '' }
        : panelHere ? { kind: 'panel', panelId: source.panelId } : { kind: 'none' }
      const geometry = stripSource.kind !== 'none' ? pressedRef.current ?? measureStrip() : measureStrip()
      // Walls: the first chip's left edge, and the + button on the right.
      const plus = stripSource.kind !== 'none' ? pressedPlusRef.current ?? plusLeft() : plusLeft()
      const bounds = { left: geometry[0]?.left ?? 0, ...(plus !== null ? { right: plus - 4 } : {}) }
      modelRef.current = { source, model: buildStripModel(geometry, stripSource, cursorX, bounds) }
    }
    return modelRef.current.model.solve(cursorX).target
  }
  const model = inStrip ? modelRef.current?.model ?? null : null
  const gap: GapSpot | null = model && stripTarget ? model.gapOf(stripTarget) : null
  /** The margin that opens the gap on the element at `side` of the gap spot. */
  const gapStyle = (here: (spot: GapSpot) => boolean, side: 'Left' | 'Right'): React.CSSProperties =>
    (model && gap && here(gap) ? { [`margin${side}`]: model.width, transition: armed ? 'margin 140ms ease' : undefined } : armed ? { transition: 'margin 140ms ease' } : {})

  useEffect(() => registerDropZone({
    id: `strip-${workspaceId}-${windowId}`,
    workspaceId,
    dock: { layoutId: '' },
    host: { windowId },
    getRect: () => headerRef.current?.getBoundingClientRect() ?? null,
    getElement: () => headerRef.current,
    strip: { resolve: (cursorX, source) => resolveRef.current(cursorX, source) },
  }), [workspaceId, windowId])

  const startPanelDrag = (e: React.MouseEvent, panelId: string) => {
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const placement = doc && placementOf(doc, panelId)
    if (placement) handleDragStart(e, { kind: 'dock-tab', workspaceId, dock: placement.dock, host, stackId: placement.stackId, panelId })
  }
  const startLayoutDrag = (e: React.MouseEvent, layout: DockLayout) => {
    const [panelId] = dockPanels(layout.dock)
    if (panelId) handleDragStart(e, { kind: 'layout', workspaceId, host, layoutId: layout.id, panelId })
  }
  const RADIUS = 'var(--node-tab-radius, 10px)'
  /** A dragged panel's chip is the ghost itself, restyled: floating along the strip over the cursor. */
  const liftedChip = (id: string): { style: React.CSSProperties; attrs: Record<string, string> } | null => {
    if (dragPanelId !== id) return null
    if (model) {
      return {
        attrs: { 'data-strip-float': '' },
        style: {
          ...GHOST_LOOK,
          // `left`, not a transform from the strip's edge: a transform would animate in from 0 when the chip
          // is lifted, and a left that was `auto` just before does not animate.
          position: 'fixed', left: model.ghostLeft(dragCursorX), top: model.top, width: model.width, margin: 0, zIndex: 9999, pointerEvents: 'none',
          borderRadius: RADIUS,
          transition: 'left 70ms ease-out',
        },
      }
    }
    // Off the strip: a strip's own drag leaves nothing of the chip; a tree's drag leaves it standing.
    return fromTree ? null : { attrs: {}, style: { display: 'none' } }
  }
  const hiddenStyle = (hidden: boolean): React.CSSProperties => (hidden ? { display: 'none' } : {})

  const closable = window.layouts.length > 1
  const doClose = (layoutId: LayoutId) => { void closeLayout(workspaceId, layoutId) }

  const onContextMenu = (e: React.MouseEvent, layout: DockLayout, group: boolean) =>
    showLayoutMenu(e, workspaceId, layout.id, { closable, ...(group ? { onRename: () => rename.begin(layout) } : {}) })

  /** Splits the shown panel: a new pane to the right of its stack. */
  const splitShown = () => {
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const layout = window.layouts.find((l) => l.id === activeLayoutId)
    if (!doc || !layout?.dock) return
    const ids = dockPanels(layout.dock)
    const panelId = ids.includes(focused ?? '') ? focused! : activeTabOf(activeTabs, firstStack(layout))
    const placement = placementOf(doc, panelId)
    if (!placement) return
    // Room is measured on the drawn pane: no room, no split.
    const viewport = globalThis.document.querySelector<HTMLElement>(`[data-window-view="${windowId}"] [data-dock-viewport]`)
    const pane = globalThis.document.querySelector<HTMLElement>(`[data-window-view="${windowId}"] [data-dock-stack-id="${placement.stackId}"]`)
    if (viewport && pane && !canSplitLayout(layout.dock, placement.stackId, viewport.clientWidth, viewport.clientHeight, (id) => doc.panels[id]?.type)) return
    splitStackRight(workspaceId, placement.dock, placement.stackId, panelId)
  }

  const panelChip = (layout: DockLayout, record: PanelRecord, active: boolean, inGroup = false) => {
    const lifted = liftedChip(record.id)
    const decoration = decorations[record.id]
    const definition = panelDefinition(record.type)
    const recordTitle = record.title || definition?.label || record.type
    const title = decoration?.retitle ? decoration.retitle(recordTitle) : recordTitle
    return (
    <div
      key={record.id}
      ref={(el) => {
        for (const [map, key] of [[chipRefs.current, record.id], ...(inGroup ? [] : [[itemRefs.current, layout.id]])] as [Map<string, HTMLElement>, string][]) {
          if (el) map.set(key, el); else map.delete(key)
        }
      }}
      data-strip-panel-id={record.id}
      {...lifted?.attrs}
      data-active={active || undefined}
      title={title}
      className={`${inGroup ? SEGMENT : CHIP} ${inGroup ? (active ? 'bg-hover text-primary' : chipTone(false)) : chipTone(active)}`}
      style={{
        ...NO_DRAG,
        ...(inGroup
          ? gapStyle((spot) => spot.at === 'group-end' && spot.layoutId === layout.id && spot.panelId === record.id, 'Right')
          : { ...gapStyle((spot) => spot.at === 'item' && spot.layoutId === layout.id, 'Left'), ...gapStyle((spot) => spot.at === 'row-end' && spot.layoutId === layout.id, 'Right') }),
        ...lifted?.style,
      }}
      // The second click of a double-click must not refocus the panel: that would blur the rename it opens.
      onClick={(e) => { if (!wasDragged.current && e.detail < 2) revealOnce(workspaceId, record.id) }}
      onDoubleClick={() => panelRename.begin(record.id, record.title || recordTitle)}
      onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault(); else startPanelDrag(e, record.id) }}
      onAuxClick={(e) => {
        if (!isMiddleClick(e)) return
        e.preventDefault()
        void closePanel(workspaceId, record.id)
      }}
      onContextMenu={(e) => { void showPanelMenu(e, workspaceId, record.id, { onRename: () => panelRename.begin(record.id, record.title || recordTitle) }) }}
    >
      <span className={`shrink-0 ${active ? definition?.tint ?? 'text-secondary' : 'text-muted'}`}>
        <TabIcon type={record.type} size={13} logo={decoration?.logo} logoAlt={decoration?.logoAlt} />
      </span>
      {panelRename.renameId === record.id ? (
        panelRename.input(record.id, 'w-24 min-w-0 px-0')
      ) : (
        <TabTitle record={record} worktree={tintWorktrees && record.worktreeId ? worktrees[record.worktreeId] : undefined}>
          {title}{decoration?.dirty ? ' •' : ''}
        </TabTitle>
      )}
      {decoration?.status}
      <CloseButton label="Close tab" active={active} hidden={!!lifted} onClose={() => { void closePanel(workspaceId, record.id) }} />
    </div>
    )
  }

  const items = window.layouts.map((layout) => {
    const layoutActive = layout.id === activeLayoutId
    const ids = dockPanels(layout.dock)
    if (ids.length === 1) {
      const record = panels[ids[0]]
      return record && <React.Fragment key={layout.id}>{panelChip(layout, record, layoutActive)}</React.Fragment>
    }
    const label = ids.length === 0 ? 'New tab' : layout.name
    const anchor = (
      <div
        ref={(el) => { if (ids.length === 0) { if (el) itemRefs.current.set(layout.id, el); else itemRefs.current.delete(layout.id) } }}
        data-layout-id={layout.id}
        data-active={layoutActive || undefined}
        title={label}
        className={`${ids.length === 0 ? CHIP : SEGMENT} ${ids.length === 0 ? chipTone(layoutActive) : `${layoutActive ? 'text-primary' : 'text-muted'} hover:text-primary hover:bg-surface-5`} ${ids.length > 0 && rename.renameId !== layout.id ? 'pr-2.5' : ''}`}
        style={NO_DRAG}
        // The second click of a double-click must not switch again: that would steal the focus from the rename it opens.
        onClick={(e) => { if (!wasDragged.current && e.detail < 2) switchLayout(workspaceId, host, layout.id) }}
        onDoubleClick={() => { if (ids.length > 0) rename.begin(layout) }}
        onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault(); else if (ids.length > 0) startLayoutDrag(e, layout) }}
        onAuxClick={(e) => {
          if (!isMiddleClick(e) || !closable) return
          e.preventDefault()
          doClose(layout.id)
        }}
        onContextMenu={(e) => { void onContextMenu(e, layout, ids.length > 0) }}
      >
        <span className="shrink-0 text-muted"><LayoutGlyph dock={layout.dock} shown={layoutActive} focused={focused} /></span>
        {rename.renameId === layout.id ? (
          rename.input(layout.id, 'w-20 min-w-0 px-0')
        ) : ids.length === 0 ? (
          <span className="min-w-0 flex-1 truncate">{label}</span>
        ) : null}
        {ids.length === 0 && closable && <CloseButton label="Close tab" active={layoutActive} onClose={() => doClose(layout.id)} />}
      </div>
    )
    if (ids.length === 0) return <React.Fragment key={layout.id}>{anchor}</React.Fragment>
    const shown = ids.includes(focused ?? '') ? focused : activeTabOf(activeTabs, firstStack(layout))
    return (
      <div
        key={layout.id}
        ref={(el) => { if (el) itemRefs.current.set(layout.id, el); else itemRefs.current.delete(layout.id) }}
        data-layout-group={layout.id}
        className="relative flex min-w-0"
        style={{
          ...gapStyle((spot) => spot.at === 'item' && spot.layoutId === layout.id, 'Left'),
          ...gapStyle((spot) => spot.at === 'row-end' && spot.layoutId === layout.id, 'Right'),
          ...hiddenStyle(liftedLayoutId === layout.id && (!fromTree || !!model)),
        }}
      >
        <div className={`flex items-center h-6 overflow-hidden rounded-[var(--node-tab-radius,10px)] min-w-0 transition-colors ${layoutActive ? 'bg-surface-2' : 'hover:bg-surface-2'}`}>
          {anchor}
          {ids.map((id, i) => panels[id] && (
            <React.Fragment key={id}>
              {/* The anchor's separator is full height, to set the layout apart from its panels. */}
              <span aria-hidden data-group-separator className={`w-px shrink-0 self-center bg-current opacity-15 ${i === 0 ? 'h-full' : 'h-3.5'}`} style={{ ...gapStyle((spot) => spot.at === 'member' && spot.layoutId === layout.id && spot.panelId === id, 'Left'), ...hiddenStyle(dragPanelId === id && !!model) }} />
              {panelChip(layout, panels[id], layoutActive && id === shown, true)}
            </React.Fragment>
          ))}
        </div>
      </div>
    )
  })

  return (
    <div
      ref={headerRef}
      data-window-header={windowId}
      className={`app-header-bar gap-1 select-none ${floating ? 'absolute top-0 left-0 right-0 z-20' : 'flex-shrink-0 border-b border-subtle'}`}
      // The solid band a window's tab bar had before the compact header, unless the view shows through.
      style={{
        ...(floating ? null : { backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }),
        ...(leadingInset ? { paddingLeft: leadingInset } : null),
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {items}
      {model && !dragPanelId && (
        // Whatever the strip has no chip of (a layout, collapsed to its name, or a panel of another window,
        // a canvas node or a remote drag), following the cursor along the strip.
        <div
          aria-hidden
          data-strip-float
          style={{ position: 'fixed', left: 0, top: model.top, width: model.width, transform: `translateX(${model.ghostLeft(dragCursorX)}px)`, transition: 'transform 70ms ease-out', pointerEvents: 'none', zIndex: 9999 }}
        >
          <DropGhostChip data-strip-ghost="float" style={{ width: '100%', minWidth: 0 }}>{dragTitle}</DropGhostChip>
        </div>
      )}
      {/* While a chip of this strip is dragged, the + steps aside to just past the room the right wall gives. */}
      <div data-new-tab-slot className="flex self-center" style={{ marginLeft: model?.plusShift ?? 0, transition: armed ? 'margin 140ms ease' : undefined }}>
        <NewTabButton items={newTabItems()} onPick={(type) => { createPanel(workspaceId, type) }} />
      </div>
      {/* Fills the row, so Split sits at the far right; drags the window. */}
      <div className="flex-1 self-stretch min-w-[8px]" />
      <Tooltip label="Split right">
        <button
          type="button"
          aria-label="Split"
          className="flex items-center justify-center self-center w-6 h-6 rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer focus:outline-none"
          style={NO_DRAG}
          onClick={splitShown}
        >
          <Columns size={14} />
        </button>
      </Tooltip>
    </div>
  )
}

/** A drop target as the strip's own kind; null for any other. */
function stripTargetOf(target: DropTarget): StripTarget | null {
  switch (target.kind) {
    case 'tab-slot': return { kind: 'tab-slot', index: target.index }
    case 'group-slot': return { kind: 'group-slot', layoutId: target.layoutId, beside: target.beside, side: target.side, slot: target.slot }
    case 'group-home': return { kind: 'group-home', layoutId: target.layoutId, slot: target.slot }
    default: return null
  }
}

/** The first stack of a layout's tree, whose shown tab stands for the group. */
function firstStack(layout: DockLayout) {
  let node = layout.dock!
  while (node.kind === 'split') node = node.children[0]
  return node
}
