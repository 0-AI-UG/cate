// =============================================================================
// useDockTabActions — tab click, context menu, rename, close, and the
// new-tab / split-with helpers used by both the +/split buttons and the
// context menus. Pure interaction layer for DockTabStack.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { DockTabStack as DockTabStackType, PanelState, PanelType } from '../../shared/types'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { removeDetachedPanelRecords } from '../lib/canvas/removeDetachedPanelRecords'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { useAppStore } from '../stores/appStore'
import type { DockStore } from '../stores/dockStore'
import { getPanelDef } from '../panels/registry'
import { setActivePanel } from '../lib/activePanel'

export interface DockTabActionsParams {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  dockStoreApi: StoreApi<DockStore>
  workspaceId?: string
  getPanelProp?: (panelId: string) => PanelState | undefined
  onClosePanel?: (panelId: string) => void
  onPanelRemoved?: (panelId: string) => void
  onPanelRenamed?: (panelId: string, title: string) => void
  excludePanelTypes?: PanelType[]
  localOnly?: boolean
  activePanel: PanelState | undefined
}

export function useDockTabActions(params: DockTabActionsParams) {
  const {
    stack, zone, dockStoreApi, workspaceId, getPanelProp,
    onClosePanel, onPanelRemoved, onPanelRenamed, excludePanelTypes, localOnly, activePanel,
  } = params

  const setActiveTab = useCallback((stackId: string, index: number) => {
    dockStoreApi.getState().setActiveTab(stackId, index)
  }, [dockStoreApi])

  // --- Inline rename --------------------------------------------------------
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameId])
  const commitRename = (panelId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) {
      const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
      // renamePanelByUser sets titleUserOverridden so the agent-name tab title
      // (terminalRegistry) won't clobber a manual rename; onPanelRenamed keeps
      // detached dock windows in sync (main's rename feature).
      if (wsId) useAppStore.getState().renamePanelByUser(wsId, panelId, trimmed)
      onPanelRenamed?.(panelId, trimmed)
    }
    setRenameId(null)
  }
  const beginRename = (panelId: string, currentTitle: string) => {
    setRenameValue(currentTitle)
    setRenameId(panelId)
  }

  const getPanelLocal = useCallback(
    (panelId: string): PanelState | undefined => {
      if (getPanelProp) return getPanelProp(panelId)
      const wsId = useAppStore.getState().selectedWorkspaceId
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      return ws?.panels[panelId]
    },
    [getPanelProp],
  )

  // --- Move to new window ---------------------------------------------------
  const moveTabToNewWindow = useCallback(
    async (panelId: string) => {
      const panel = getPanelLocal(panelId)
      if (!panel) return
      const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
      const sourceWs = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      const snapshot = createTransferSnapshot(
        panel,
        { type: 'dock', zone, stackId: stack.id },
        { origin: { x: 100, y: 100 }, size: { width: 800, height: 600 } },
        {
          // A canvas tab carries its children; without this the new window
          // renders them as generic "Panel" stubs (mirrors the drag path).
          resolveChildPanel: (childId: string) => sourceWs?.panels[childId],
          workspaceRootPath: sourceWs?.rootPath || undefined,
        },
      )
      // Detach FIRST — only tear down the source once the new window actually
      // exists. dragDetach returns null when main refuses (e.g. macOS
      // fullscreen); doing the undock/release before that check would orphan the
      // panel (removed from the dock tree, xterm disposed) with nowhere to live.
      const winId = await window.electronAPI.dragDetach(snapshot, wsId)
      if (winId == null) return
      dockStoreApi.getState().undockPanel(panelId)
      if (panel.type === 'terminal') terminalRegistry.release(panelId)
      onPanelRemoved?.(panelId)
      // Drop its record (and a canvas's children) from this workspace so every
      // system — overview, command palette, session, counts — agrees it's no
      // longer here. The receive side re-adds it on drop-back.
      removeDetachedPanelRecords(wsId, panelId, panel.type)
    },
    [getPanelLocal, zone, stack.id, dockStoreApi, onPanelRemoved, workspaceId],
  )

  // --- Create / add / split helpers ----------------------------------------
  const createPanelOfType = useCallback(
    (type: PanelType): string | null => {
      const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
      const placement: import('../stores/appStore').PanelPlacement = localOnly
        ? { target: 'none' }
        : { target: 'dock', zone }
      const filePath =
        activePanel?.type === 'editor' && !activePanel.diffMode ? activePanel.filePath : undefined
      return getPanelDef(type).create({ workspaceId: wsId, placement, filePath })
    },
    [activePanel, workspaceId, zone, localOnly],
  )

  const addTabOfType = useCallback(
    (type: PanelType) => {
      const newId = createPanelOfType(type)
      if (!newId) return
      dockStoreApi.getState().dockPanel(newId, zone, {
        type: 'tab',
        stackId: stack.id,
      })
    },
    [createPanelOfType, dockStoreApi, zone, stack.id],
  )

  const splitWithType = useCallback(
    (type: PanelType) => {
      const newId = createPanelOfType(type)
      if (!newId) return
      dockStoreApi.getState().dockPanel(newId, zone, {
        type: 'split',
        stackId: stack.id,
        edge: 'right',
      })
    },
    [createPanelOfType, dockStoreApi, zone, stack.id],
  )

  // --- Tab context menu -----------------------------------------------------
  const handleTabContextMenu = useCallback(
    async (e: React.MouseEvent, panelId: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (!window.electronAPI) return
      const idx = stack.panelIds.indexOf(panelId)
      const hasOthers = stack.panelIds.length > 1
      const hasRight = idx >= 0 && idx < stack.panelIds.length - 1
      const panel = getPanelLocal(panelId)
      const id = await window.electronAPI.showContextMenu([
        { id: 'rename', label: 'Rename' },
        { type: 'separator' as const },
        { id: 'close', label: 'Close', accelerator: 'Cmd+W' },
        { id: 'close-others', label: 'Close Others', enabled: hasOthers },
        { id: 'close-right', label: 'Close to the Right', enabled: hasRight },
        { id: 'close-all', label: 'Close All', accelerator: 'Cmd+K Cmd+W' },
        { type: 'separator' as const },
        { id: 'split-right', label: 'Split Right' },
        { id: 'move-window', label: 'Move into New Window' },
      ])
      switch (id) {
        case 'rename':
          if (panel) beginRename(panelId, panel.title)
          break
        case 'close':
          onClosePanel?.(panelId)
          break
        case 'close-others': {
          const others = stack.panelIds.filter((p) => p !== panelId)
          others.forEach((p) => onClosePanel?.(p))
          break
        }
        case 'close-right': {
          const toClose = stack.panelIds.slice(idx + 1)
          toClose.forEach((p) => onClosePanel?.(p))
          break
        }
        case 'close-all':
          stack.panelIds.slice().forEach((p) => onClosePanel?.(p))
          break
        case 'split-right': {
          if (panel) splitWithType(panel.type)
          break
        }
        case 'move-window':
          moveTabToNewWindow(panelId)
          break
      }
    },
    [stack.panelIds, onClosePanel, getPanelLocal, moveTabToNewWindow, workspaceId, splitWithType],
  )

  // Tab-bar (empty-area) context menu — split/new menus. Returns a handler
  // that uses the supplied "visible split items" list, computed by the caller
  // since it depends on excludePanelTypes.
  const excludeKey = (excludePanelTypes ?? []).join(',')
  const handleTabBarContextMenu = useCallback(
    async (e: React.MouseEvent, visibleSplitItems: { type: PanelType; label: string }[]) => {
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      if (!window.electronAPI) return
      const id = await window.electronAPI.showContextMenu([
        {
          label: 'New Tab',
          submenu: visibleSplitItems.map((m) => ({ id: `new:${m.type}`, label: m.label })),
        },
        { type: 'separator' },
        {
          label: 'Split With',
          submenu: visibleSplitItems.map((m) => ({ id: `split:${m.type}`, label: m.label })),
        },
        { type: 'separator' },
        { id: 'close-all', label: 'Close All', enabled: stack.panelIds.length > 0 },
      ])
      if (!id) return
      if (id === 'close-all') {
        stack.panelIds.slice().forEach((p) => onClosePanel?.(p))
        return
      }
      const [kind, type] = id.split(':') as [string, PanelType]
      if (kind === 'new') addTabOfType(type)
      else if (kind === 'split') splitWithType(type)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stack.panelIds, onClosePanel, excludeKey, addTabOfType, splitWithType],
  )

  const handleTabClick = useCallback(
    (index: number) => {
      setActiveTab(stack.id, index)
      // Make the clicked tab the canonical active panel. The stack's pointer-
      // down capture already marked the OLD active tab; switching tabs must
      // re-point it so placement/routing follow the tab the user just selected.
      // mini-docks (localOnly) never touch the window-global active panel.
      const panelId = stack.panelIds[index]
      if (panelId && !localOnly) setActivePanel(panelId)
    },
    [stack.id, stack.panelIds, setActiveTab, localOnly],
  )

  return {
    // rename
    renameId,
    renameValue,
    renameInputRef,
    setRenameValue,
    setRenameId,
    commitRename,
    beginRename,
    // actions
    handleTabClick,
    handleTabContextMenu,
    handleTabBarContextMenu,
    moveTabToNewWindow,
    addTabOfType,
    splitWithType,
    createPanelOfType,
    setActiveTab,
  }
}

// Keep useMemo'd accepts predicate available to consumers — used by the
// drop-zone registration in DockTabStack.
export function useAcceptsPanelType(excludePanelTypes: PanelType[] | undefined) {
  const excludeKey = (excludePanelTypes ?? []).join(',')
  return useMemo(() => {
    if (!excludePanelTypes || excludePanelTypes.length === 0) return undefined
    const set = new Set<PanelType>(excludePanelTypes)
    return (type: PanelType) => !set.has(type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludeKey])
}
