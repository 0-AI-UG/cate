// =============================================================================
// useDockTabActions — tab click, context menu, rename, close, and the
// new-tab / split-with helpers used by both the +/split buttons and the
// context menus. Pure interaction layer for DockTabStack.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { DockTabStack as DockTabStackType, PanelState, PanelType } from '../../shared/types'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { terminalRegistry, TERMINAL_PRESETS, getAllTerminalThemes } from '../lib/terminalRegistry'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import type { DockStore } from '../stores/dockStore'

export interface DockTabActionsParams {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  dockStoreApi: StoreApi<DockStore>
  workspaceId?: string
  getPanelProp?: (panelId: string) => PanelState | undefined
  onClosePanel?: (panelId: string) => void
  onPanelRemoved?: (panelId: string) => void
  excludePanelTypes?: PanelType[]
  localOnly?: boolean
  activePanel: PanelState | undefined
}

export function useDockTabActions(params: DockTabActionsParams) {
  const {
    stack, zone, dockStoreApi, workspaceId, getPanelProp,
    onClosePanel, onPanelRemoved, excludePanelTypes, localOnly, activePanel,
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
      if (wsId) useAppStore.getState().updatePanelTitle(wsId, panelId, trimmed)
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
      const snapshot = createTransferSnapshot(
        panel,
        { type: 'dock', zone, stackId: stack.id },
        { origin: { x: 100, y: 100 }, size: { width: 800, height: 600 } },
      )
      dockStoreApi.getState().undockPanel(panelId)
      if (panel.type === 'terminal') terminalRegistry.release(panelId)
      onPanelRemoved?.(panelId)
      const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
      await window.electronAPI.dragDetach(snapshot, wsId)
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
      const app = useAppStore.getState()
      switch (type) {
        case 'editor': {
          const filePath =
            activePanel?.type === 'editor' && !activePanel.diffMode ? activePanel.filePath : undefined
          return app.createEditor(wsId, filePath, undefined, placement) || null
        }
        case 'terminal':
          return app.createTerminal(wsId, undefined, undefined, placement) || null
        case 'browser':
          return app.createBrowser(wsId, undefined, undefined, placement) || null
        case 'git':
          return app.createGit(wsId, undefined, placement) || null
        case 'fileExplorer':
          return app.createFileExplorer(wsId, undefined, placement) || null
        case 'projectList':
          return app.createProjectList(wsId, undefined, placement) || null
        case 'canvas':
          return app.createCanvas(wsId, undefined, placement) || null
        default:
          return null
      }
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
      const isTerminal = panel?.type === 'terminal'
      const currentPreset = panel?.themePreset
      const allThemes = getAllTerminalThemes()
      const customCount = allThemes.length - TERMINAL_PRESETS.length
      const defaultThemeId = useSettingsStore.getState().defaultTerminalTheme
      const defaultLabel = (() => {
        if (!defaultThemeId) return 'Default (Follow App Theme)'
        const p = allThemes.find((t) => t.id === defaultThemeId)
        return p ? `Default (${p.label})` : 'Default'
      })()
      const themeSubmenu = isTerminal
        ? [
            { id: 'theme:__default__', label: !currentPreset ? `${defaultLabel} ✓` : defaultLabel },
            { type: 'separator' as const },
            ...TERMINAL_PRESETS.map((p) => ({
              id: `theme:${p.id}`,
              label: currentPreset === p.id ? `${p.label} ✓` : p.label,
            })),
            ...(customCount > 0
              ? [
                  { type: 'separator' as const },
                  ...allThemes.slice(TERMINAL_PRESETS.length).map((p) => ({
                    id: `theme:${p.id}`,
                    label: currentPreset === p.id ? `${p.label} ✓` : p.label,
                  })),
                ]
              : []),
            { type: 'separator' as const },
            { id: 'theme:__import__', label: 'Import Theme…' },
          ]
        : []
      const id = await window.electronAPI.showContextMenu([
        { id: 'close', label: 'Close', accelerator: 'Cmd+W' },
        { id: 'close-others', label: 'Close Others', enabled: hasOthers },
        { id: 'close-right', label: 'Close to the Right', enabled: hasRight },
        { id: 'close-all', label: 'Close All', accelerator: 'Cmd+K Cmd+W' },
        { type: 'separator' as const },
        { id: 'split-right', label: 'Split Right' },
        { id: 'move-window', label: 'Move into New Window' },
        ...(isTerminal
          ? ([{ type: 'separator' as const }, { label: 'Theme', submenu: themeSubmenu }] as any[])
          : []),
      ])
      if (id?.startsWith('theme:')) {
        const presetId = id.slice('theme:'.length)
        if (presetId === '__import__') {
          useUIStore.getState().openSettings('terminal')
          return
        }
        const next = presetId === '__default__' ? undefined : presetId
        const wsId = workspaceId ?? useAppStore.getState().selectedWorkspaceId
        if (wsId) useAppStore.getState().setPanelThemePreset(wsId, panelId, next)
        return
      }
      switch (id) {
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
    },
    [stack.id, setActiveTab],
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
