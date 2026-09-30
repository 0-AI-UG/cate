// The Cmd+K palette: every available command, the workspaces, the navigable
// panels of the current workspace (every window of it, from the document) and
// its files by name. With no query it lists recent files instead of searching.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FileText, Search as MagnifyingGlass } from 'lucide-react'
import { Icon, LoadingState, PaletteDialogShell, PaletteTextInput, useResolvedShortcuts } from '@kernel/ui'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientHas } from '@client/connections'
import { useClientState, useDocument } from '@client/document/ui'
import { useWorkspaceList } from '@client/workspaces/ui'
import { focusedLeafIn, panelDefinition } from '@client/host'
import { getRecentFiles } from '@workspace/files/client'
import { pathDisplayName } from '@workspace/files/contract'
import { createLogger } from '@kernel/log/contract'
import { clientApp } from '../app'
import { paletteActions, paletteCommands, runAction, useActionsVersion } from '../actions/registry'
import { canOpenFiles, openWorkspaceFile, revealPanel, selectWorkspace } from '../navigation'
import { useWindowId } from '../state/windowContext'
import { useUIStore } from '../state/uiStore'
import { commandItems, panelItems, workspaceItems, type FileItem, type PaletteItem } from './items'

const log = createLogger('palette')
const ICON_SIZE = 16

export function CommandPalette(): JSX.Element | null {
  const open = useUIStore((s) => s.commandPaletteOpen)
  if (!open) return null
  return <OpenPalette />
}

function OpenPalette(): JSX.Element {
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen)
  const workspaceId = useUIStore((s) => s.selectedWorkspaceId)
  const windowId = useWindowId()
  const shortcuts = useResolvedShortcuts()
  useActionsVersion()
  const list = useWorkspaceList(clientApp().workspaces)
  const doc = useDocument(workspaceId, (d) => d)
  const clientState = useClientState(workspaceId, (s) => s)
  const focusedId = focusedLeafIn(doc, clientState)

  const [searchText, setSearchText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileResults, setFileResults] = useState<FileItem[]>([])
  const [searching, setSearching] = useState(false)
  const selectedRowRef = useRef<HTMLDivElement>(null)
  const query = searchText.trim().toLowerCase()

  const close = useCallback(() => setOpen(false), [setOpen])

  const focusedRecord = focusedId ? doc.panels[focusedId] : undefined
  const focusedDefinition = focusedRecord ? panelDefinition(focusedRecord.type) : undefined

  const commands = commandItems({
    actions: paletteActions(),
    shortcuts,
    runAction: (action) => { runAction(action) },
    commands: paletteCommands(),
    focused: focusedRecord && focusedDefinition ? { record: focusedRecord, definition: focusedDefinition } : null,
    sendOp: (panelId, op) => {
      if (!workspaceId) return
      tryRuntimeFor(workspaceId)?.session.op({ panelId, op }).catch((err) => log.warn('panel command failed: %s', err))
    },
    clientHas,
  }, query)
  const workspaces = workspaceItems(list.entries, workspaceId, query)
  const panels = useMemo(() => panelItems(doc, windowId, panelDefinition, query), [doc, windowId, query])

  // File names: searched with a query (debounced), recent files without one.
  const filesAvailable = !!workspaceId && canOpenFiles()
  useEffect(() => {
    if (!filesAvailable || !query) { setFileResults([]); return }
    const runtime = tryRuntimeFor(workspaceId!)
    if (!runtime) return
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(() => {
      runtime.search.files({ query: searchText, maxResults: 50 }).then(
        (hits) => {
          if (cancelled) return
          setFileResults(hits.filter((h) => !h.isDirectory).map((h) => ({ kind: 'file', path: h.path, name: h.name, relativePath: h.relativePath })))
        },
        () => { if (!cancelled) setFileResults([]) },
      ).finally(() => { if (!cancelled) setSearching(false) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer); setSearching(false) }
  }, [filesAvailable, query, searchText, workspaceId])

  const recentFiles = useMemo<FileItem[]>(() => {
    if (query || !filesAvailable) return []
    return getRecentFiles(workspaceId!)
      .map((path) => ({ kind: 'file', path, name: pathDisplayName(path) || path, relativePath: path }))
  }, [query, filesAvailable, workspaceId])

  const files = query ? fileResults : recentFiles
  const flat: PaletteItem[] = [...commands, ...workspaces, ...panels, ...files]
  const total = flat.length

  useEffect(() => {
    setSelectedIndex((prev) => (prev >= total ? Math.max(0, total - 1) : prev))
  }, [total])
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const activate = (item: PaletteItem): void => {
    // Close first, so an action that opens another overlay is not covered.
    flushSync(close)
    if (item.kind === 'command') item.run()
    else if (item.kind === 'workspace') void selectWorkspace(item.id)
    else if (item.kind === 'panel' && workspaceId) void revealPanel(workspaceId, item.panelId)
    else if (item.kind === 'file' && workspaceId) void openWorkspaceFile(workspaceId, item.path)
  }

  const sections: { label: string; items: PaletteItem[] }[] = [
    { label: 'Commands', items: commands },
    { label: 'Workspaces', items: workspaces },
    { label: 'Panels', items: panels },
    { label: query ? 'Files' : 'Recent Files', items: files },
  ]

  let index = 0
  return (
    <PaletteDialogShell
      onClose={close}
      ariaLabel="Command palette"
      cardClassName="w-[600px] max-w-[600px] max-h-[440px] mt-[120px] overflow-hidden flex flex-col self-start"
      cardProps={{ 'data-onboarding': 'command-palette' }}
    >
      <div className="p-2 shrink-0">
        <PaletteTextInput
          icon={<MagnifyingGlass size={15} />}
          autoFocus
          value={searchText}
          onChange={(e) => { setSearchText(e.target.value); setSelectedIndex(0) }}
          onKeyDown={(e) => {
            switch (e.key) {
              case 'ArrowDown':
                e.preventDefault()
                setSelectedIndex((prev) => (total === 0 ? 0 : (prev + 1) % total))
                break
              case 'ArrowUp':
                e.preventDefault()
                setSelectedIndex((prev) => (total === 0 ? 0 : (prev - 1 + total) % total))
                break
              case 'Enter': {
                e.preventDefault()
                const item = flat[selectedIndex]
                if (item) activate(item)
                break
              }
              case 'Escape':
                e.preventDefault()
                close()
                break
            }
          }}
          placeholder="Search commands, workspaces, panels and files"
        />
      </div>
      <div className="flex-1 overflow-y-auto pb-1.5">
        {total === 0 ? (
          <div className="text-muted text-[13px] text-center py-5">
            {searching ? <LoadingState label="Searching…" size={14} /> : 'No results'}
          </div>
        ) : sections.map((section, sectionIndex) => {
          if (section.items.length === 0) return null
          const showSeparator = sections.slice(0, sectionIndex).some((s) => s.items.length > 0)
          return (
            <React.Fragment key={section.label}>
              {showSeparator && <div className="mx-3.5 my-1 border-t border-subtle" />}
              <div className="px-3.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{section.label}</div>
              {section.items.map((item) => {
                const i = index++
                const selected = i === selectedIndex
                return (
                  <div
                    key={`${item.kind}:${itemKey(item)}`}
                    ref={selected ? selectedRowRef : undefined}
                    role="option"
                    aria-selected={selected}
                    className={`flex items-center gap-2.5 mx-1.5 px-2.5 py-1.5 cursor-pointer rounded-md ${
                      selected ? 'bg-[rgb(var(--agent-rgb))]/25 ring-1 ring-inset ring-[rgb(var(--agent-rgb))]/40' : ''
                    }`}
                    onClick={() => activate(item)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <ItemRow item={item} />
                  </div>
                )
              })}
            </React.Fragment>
          )
        })}
      </div>
    </PaletteDialogShell>
  )
}

function itemKey(item: PaletteItem): string {
  switch (item.kind) {
    case 'command': return item.id
    case 'workspace': return item.id
    case 'panel': return item.panelId
    case 'file': return item.path
  }
}

function ItemRow({ item }: { item: PaletteItem }): JSX.Element {
  switch (item.kind) {
    case 'command':
      return <>
        <span className="shrink-0 text-secondary">{item.icon ? <Icon name={item.icon} size={ICON_SIZE} /> : <FileText size={ICON_SIZE} />}</span>
        <span className="text-[13px] text-primary flex-1 truncate">{item.title}</span>
        {item.shortcut && <kbd className="text-[11px] text-muted shrink-0">{item.shortcut}</kbd>}
      </>
    case 'workspace':
      return <>
        <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-[var(--text-muted)]" />
        <div className="flex-1 min-w-0">
          <div className="text-primary text-[13px] truncate">{item.name}</div>
          {item.detail && <div className="text-muted text-[11px] truncate">{item.detail}</div>}
        </div>
        {item.current && <span className="text-[11px] text-muted">Current</span>}
      </>
    case 'panel':
      return <>
        <span className="shrink-0 text-secondary"><Icon name={item.icon} size={ICON_SIZE} /></span>
        <span className="text-[13px] text-primary flex-1 truncate">{item.title}</span>
        <span className="text-[11px] text-muted">{item.secondary}</span>
      </>
    case 'file':
      return <>
        <span className="shrink-0 text-amber-400"><FileText size={ICON_SIZE} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-primary text-[13px] truncate">{item.name}</div>
          <div className="text-muted text-[11px] truncate">{item.relativePath}</div>
        </div>
      </>
  }
}
