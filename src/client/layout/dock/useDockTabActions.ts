// What a dock stack's tabs do: select, rename, close, the tab and tab bar
// menus, new tab and split. Selection is client state; everything else is a
// document op (closing asks first through the panel's close guard).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  dockPanels,
  isCanvasDock,
  type DocChange,
  type DockRef,
  type DockStack,
  type PanelId,
  type PlaceTarget,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { ContextMenuItem } from '@kernel/ui/contract'
import { clientUi } from '@kernel/ui'
import { clientHas } from '@client/connections'
import { clientStateFor, documentStoreFor } from '@client/document'
import {
  closePanel,
  closePanels,
  createPanel,
  newId,
  onPanelRenameRequest,
  panelDefaultSize,
  panelDefinitions,
} from '@client/host'
import { materialize, presentationsFor } from './presentation'
import { tabMenuContributions } from './decorations'

/** The type a "Split Right" creates: the placeholder picker, when one is
 *  registered. */
function splitPlaceholderType(): string | undefined {
  return panelDefinitions().find((definition) => definition.placeholder)?.type
}

export interface DockTabActionsParams {
  workspaceId: string
  dock: DockRef
  /** The stack as drawn (a merged stack holds every tab of its window). */
  stack: DockStack
  activePanelId: PanelId | undefined
  canSplit?: () => boolean
}

/** Makes what a window shows real before an edit through it. */
export function materializeWindow(workspaceId: string, dock: DockRef): void {
  if (isCanvasDock(dock)) return
  const store = documentStoreFor(workspaceId)
  if (!store) return
  const changes = materialize(store.getSnapshot(), dock.windowId, presentationsFor(workspaceId).getSnapshot())
  if (changes.length > 0) store.propose({ kind: 'batch', changes })
}

/** Panels of the canvas nodes selected with the one this dock belongs to;
 *  null unless several nodes are selected. */
function multiSelectionPanels(workspaceId: string, dock: DockRef): PanelId[] | null {
  if (!isCanvasDock(dock)) return null
  const selection = clientStateFor(workspaceId)?.getSnapshot().selection[dock.canvasId] ?? []
  if (selection.length < 2 || !selection.includes(dock.nodeId)) return null
  const canvas = documentStoreFor(workspaceId)?.getSnapshot().canvases[dock.canvasId]
  return selection.flatMap((nodeId) => dockPanels(canvas?.nodes[nodeId]?.dock))
}

export function useDockTabActions({ workspaceId, dock, stack, activePanelId, canSplit }: DockTabActionsParams) {
  const setActiveTab = useCallback((panelId: PanelId) => {
    clientStateFor(workspaceId)?.setActiveTab(stack.id, panelId)
  }, [workspaceId, stack.id])

  const handleTabClick = useCallback((panelId: PanelId) => {
    const state = clientStateFor(workspaceId)
    state?.setActiveTab(stack.id, panelId)
    state?.focus(panelId)
  }, [workspaceId, stack.id])

  // --- Inline rename ---------------------------------------------------------
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Committing the untouched seed writes nothing.
  const renameSeedRef = useRef('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameId])
  const beginRename = useCallback((panelId: string) => {
    const title = documentStoreFor(workspaceId)?.getSnapshot().panels[panelId]?.title ?? ''
    renameSeedRef.current = title
    setRenameValue(title)
    setRenameId(panelId)
  }, [workspaceId])
  const commitRename = useCallback((panelId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== renameSeedRef.current) {
      documentStoreFor(workspaceId)?.propose({ kind: 'updatePanel', id: panelId, patch: { title: trimmed } })
    }
    setRenameId(null)
  }, [renameValue, workspaceId])
  useEffect(() => onPanelRenameRequest((ws, panelId) => {
    if (ws === workspaceId && stack.panels.includes(panelId)) beginRename(panelId)
  }), [workspaceId, stack.panels, beginRename])

  // --- Create -----------------------------------------------------------------
  const createPanelOfType = useCallback((type: string, at: 'tab' | 'split') => {
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    if (!doc) return
    materializeWindow(workspaceId, dock)
    const target: PlaceTarget = at === 'tab'
      ? { to: 'stack', dock, stackId: stack.id }
      : { to: 'split', dock, beside: stack.id, side: 'right', stackId: newId(), splitId: newId() }
    const origin = activePanelId ? doc.panels[activePanelId] : undefined
    createPanel(workspaceId, type, { at: target, worktreeId: origin?.worktreeId })
  }, [workspaceId, dock, stack.id, activePanelId])

  const addTabOfType = useCallback((type: string) => createPanelOfType(type, 'tab'), [createPanelOfType])

  const splitPanel = useCallback(() => {
    if (canSplit && !canSplit()) return
    const type = splitPlaceholderType() ?? doc(workspaceId)?.panels[activePanelId ?? '']?.type
    if (type) createPanelOfType(type, 'split')
  }, [createPanelOfType, canSplit, workspaceId, activePanelId])

  // --- Move and close -----------------------------------------------------------
  const moveTabToNewWindow = useCallback((panelId: string) => {
    const store = documentStoreFor(workspaceId)
    const record = store?.getSnapshot().panels[panelId]
    if (!store || !record) return
    const change: DocChange = {
      kind: 'placePanel',
      id: panelId,
      at: {
        to: 'window',
        windowId: newId(),
        stackId: newId(),
        bounds: { origin: { x: window.screenX + 60, y: window.screenY + 60 }, size: panelDefaultSize(record.type) },
      },
    }
    store.propose(change)
  }, [workspaceId])

  // Closing through a presented dock keeps the layout the user sees.
  const before = useCallback((current: WorkspaceDocument) => (
    isCanvasDock(dock) ? [] : materialize(current, dock.windowId, presentationsFor(workspaceId).getSnapshot())
  ), [workspaceId, dock])
  const closeOne = useCallback((panelId: string) => { void closePanel(workspaceId, panelId, { before }) }, [workspaceId, before])
  const closeMany = useCallback((ids: string[]) => closePanels(workspaceId, ids, { before }), [workspaceId, before])

  /** Several canvas nodes selected: every menu collapses to the bulk close. */
  const showMultiSelectionMenu = useCallback(async (): Promise<boolean> => {
    const panels = multiSelectionPanels(workspaceId, dock)
    if (!panels) return false
    const id = await showMenu([{ id: 'close-all', label: 'Close All' }])
    if (id === 'close-all') await closeMany(panels)
    return true
  }, [workspaceId, dock, closeMany])

  const showCloseAll = !isCanvasDock(dock)

  const handleTabContextMenu = useCallback(async (e: React.MouseEvent, panelId: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (await showMultiSelectionMenu()) return
    const record = doc(workspaceId)?.panels[panelId]
    if (!record) return
    const index = stack.panels.indexOf(panelId)
    const context = { workspaceId, record }
    const contributed = tabMenuContributions().flatMap((c) => c.items(context))
    const menu: ContextMenuItem[] = [
      ...contributed,
      ...(contributed.length > 0 ? [{ type: 'separator' as const }] : []),
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
      { id: 'close-others', label: 'Close Others', enabled: stack.panels.length > 1 },
      { id: 'close-right', label: 'Close to the Right', enabled: index >= 0 && index < stack.panels.length - 1 },
      ...(showCloseAll ? [{ id: 'close-all', label: 'Close All' }] : []),
      { type: 'separator' },
      { id: 'split-right', label: 'Split Right', enabled: canSplit?.() ?? true },
      ...(clientHas('windows') ? [{ id: 'move-window', label: 'Move into New Window' }] : []),
    ]
    const id = await showMenu(menu)
    if (!id) return
    switch (id) {
      case 'rename': beginRename(panelId); return
      case 'close': closeOne(panelId); return
      case 'close-others': await closeMany(stack.panels.filter((p) => p !== panelId)); return
      case 'close-right': await closeMany(stack.panels.slice(index + 1)); return
      case 'close-all': await closeMany([...stack.panels]); return
      case 'split-right': splitPanel(); return
      case 'move-window': moveTabToNewWindow(panelId); return
    }
    for (const contribution of tabMenuContributions()) {
      if (await contribution.run(id, context)) return
    }
  }, [showMultiSelectionMenu, workspaceId, stack.panels, showCloseAll, canSplit, beginRename, closeOne, closeMany, splitPanel, moveTabToNewWindow])

  const handleTabBarContextMenu = useCallback(async (e: React.MouseEvent, items: { type: string; label: string }[]) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    if (await showMultiSelectionMenu()) return
    const groups: ContextMenuItem[][] = [
      [{ label: 'New Tab', submenu: items.map((m) => ({ id: `new:${m.type}`, label: m.label })) }],
      [{ id: 'split', label: 'Split Right', enabled: canSplit?.() ?? true }],
    ]
    if (showCloseAll) groups.push([{ id: 'close-all', label: 'Close All', enabled: stack.panels.length > 0 }])
    const menu = groups.flatMap((group, i) => (i === 0 ? group : [{ type: 'separator' } as ContextMenuItem, ...group]))
    const id = await showMenu(menu)
    if (!id) return
    if (id === 'split') { splitPanel(); return }
    if (id === 'close-all') { await closeMany([...stack.panels]); return }
    if (id.startsWith('new:')) addTabOfType(id.slice(4))
  }, [showMultiSelectionMenu, canSplit, showCloseAll, stack.panels, splitPanel, closeMany, addTabOfType])

  return {
    renameId,
    renameValue,
    renameInputRef,
    setRenameValue,
    setRenameId,
    commitRename,
    beginRename,
    handleTabClick,
    handleTabContextMenu,
    handleTabBarContextMenu,
    moveTabToNewWindow,
    addTabOfType,
    splitPanel,
    setActiveTab,
    closePanel: closeOne,
  }
}

function doc(workspaceId: string) {
  return documentStoreFor(workspaceId)?.getSnapshot() ?? null
}

/** The shell's context menu; resolves null on a client without one. */
function showMenu(items: ContextMenuItem[]): Promise<string | null> {
  const ui = clientUi()
  return ui.showContextMenu ? ui.showContextMenu(items) : Promise.resolve(null)
}
