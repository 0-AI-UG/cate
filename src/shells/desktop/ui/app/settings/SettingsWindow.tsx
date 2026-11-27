// The settings window: a nav (search, grouped pages, scroll-spy) beside a
// scrollable column of pages. One list holds two sections: Device (client
// settings) and, while a workspace is active, Workspace (that workspace's
// settings, for everyone in it), each under its own heading. With no
// workspace only the device pages exist. A search spans both.
//
// The search box filters rows across every page (SettingsSearchContext from
// kernel/interaction); empty pages collapse and the nav lists only pages with matches.
// The nav renders into the sidebar's `overlay-sidebar-slot` and the content
// into the shell's `settings-content-slot` when both exist, else the window
// takes the whole screen.

import { DropdownSelect, SearchField, useDialogLayer } from '../../kernel/interaction'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Braces as BracketsCurly,
  FolderOpen,
  GitBranch,
  Laptop,
  LayoutDashboard,
  RotateCcw,
  Server,
  Settings2,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { workspaceLocation, type WorkspaceListSnapshot } from '@client/workspaces'
import { SettingsSearchContext } from '../../kernel/interaction'
import { clientSettingsTable } from '../../../settings'
import { clientSettings } from '../../kernel/settings'
import { createLogger } from '@kernel/log/contract'
import { LeftSidebarReopen, OverlayHeader } from '../chrome/chrome'
import { UpdateButton } from '../chrome/UpdateButton'
import { useDesktopPort } from '../desktop'
import { tryClientApp } from '../app'
import { SETTINGS_GROUPS, SETTINGS_SCOPES, resolveSectionId, useSettingsPages, visiblePages, type SettingsGroup, type SettingsPage, type SettingsScope } from './registry'

const log = createLogger('settings')

const SCOPE_ICONS: Record<SettingsScope, LucideIcon> = {
  client: Laptop,
  workspace: FolderOpen,
}

const GROUP_ICONS: Record<SettingsGroup, LucideIcon> = {
  general: Settings2,
  runtime: Server,
  layout: LayoutDashboard,
  tools: Wrench,
  sourceControl: GitBranch,
  agents: Sparkles,
}

const NO_WORKSPACES: WorkspaceListSnapshot = { entries: [], open: [] }
const noSubscribe = (): (() => void) => () => {}

/** The workspace list: its entries and which of them are open. */
function useWorkspaceSnapshot(): WorkspaceListSnapshot {
  const list = tryClientApp()?.workspaces
  return useSyncExternalStore(list?.subscribe ?? noSubscribe, list?.getSnapshot ?? (() => NO_WORKSPACES))
}

const sectionDomId = (id: string): string => `settings-section-${id.replace(/[^a-z0-9-]+/gi, '-')}`

export interface SettingsWindowProps {
  /** The active workspace, or null on the welcome screen. */
  workspaceId: string | null
  /** A page id (or title) to scroll to on open. */
  section?: string
  onClose: () => void
}

export function SettingsWindow({ workspaceId: activeId, section, onClose }: SettingsWindowProps): JSX.Element {
  const snapshot = useWorkspaceSnapshot()
  // The project whose settings show: the active one unless picked in the nav.
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => setPicked(null), [activeId])
  const openEntries = snapshot.entries.filter((entry) => snapshot.open.includes(entry.id))
  const workspaceId = activeId && picked && openEntries.some((entry) => entry.id === picked) ? picked : activeId
  const allPages = useSettingsPages()
  const pages = useMemo(() => visiblePages(allPages, workspaceId), [allPages, workspaceId])
  const desktop = useDesktopPort()
  const workspace = snapshot.entries.find((entry) => entry.id === workspaceId) ?? null
  const scopeTitle = (scope: SettingsScope): string =>
    scope === 'client' ? 'This device' : `Workspace: ${workspace?.name ?? 'this workspace'}`
  const scopeDescription = (scope: SettingsScope): string => {
    if (scope === 'client') return 'Saved on this computer. Applies to every workspace you open here.'
    const where = workspace ? workspaceLocation(workspace) : null
    return `${where ? `${where}. ` : ''}Saved with the workspace. Applies for everyone connected to it.`
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<{ sidebar: HTMLElement; content: HTMLElement } | null>(null)
  const [rawQuery, setRawQuery] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set())
  const [visible, setVisible] = useState<Set<string>>(() => new Set(pages.map((p) => p.id)))
  const query = rawQuery.trim().toLowerCase()
  const searching = query !== ''
  // Both scopes share one list, each under its own heading.
  const shownScopes = SETTINGS_SCOPES
  const shownPages = pages

  useLayoutEffect(() => {
    const sidebar = document.getElementById('overlay-sidebar-slot')
    const content = document.getElementById('settings-content-slot')
    if (sidebar && content) setSlots({ sidebar, content })
  }, [])

  // Scroll to the requested page on open.
  useEffect(() => {
    setRawQuery('')
    setConfirmingReset(false)
    const target = resolveSectionId(section, pages)
    if (!target) return
    setActiveIds(new Set([target]))
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`#${sectionDomId(target)}`)?.scrollIntoView?.({ block: 'start', behavior: 'auto' })
    })
    // Only when the request changes, not on every page registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, slots])

  // Which pages still have visible rows for the query.
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const next = new Set<string>()
    for (const page of shownPages) {
      if (query === '' || page.title.toLowerCase().includes(query)) next.add(page.id)
      else if (root.querySelector(`#${sectionDomId(page.id)} [data-srow]`)) next.add(page.id)
    }
    setVisible(next)
  }, [query, shownPages, slots])

  // Scroll-spy: every page overlapping the viewport is active.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-section-id]'))
      const rootRect = root.getBoundingClientRect()
      const inView = sections
        .filter((s) => {
          if (s.hidden) return false
          const rect = s.getBoundingClientRect()
          return rect.bottom > rootRect.top && rect.top < rootRect.bottom
        })
        .map((s) => s.dataset.sectionId)
        .filter((id): id is string => Boolean(id))
      const fallback = sections.find((s) => !s.hidden)?.dataset.sectionId
      setActiveIds(new Set(inView.length > 0 ? inView : fallback ? [fallback] : []))
    }
    onScroll()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [visible, shownPages, slots])

  // Escape clears the search first, then closes.
  const dialogOrder = useDialogLayer((event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (rawQuery) setRawQuery('')
    else onClose()
  })

  const openSettingsFile = async (): Promise<void> => {
    try {
      await desktop!.openClientSettingsFile()
    } catch (err) {
      log.warn('could not open settings.json: %s', err)
    }
  }

  const restoreDefaults = (): void => {
    if (!confirmingReset) {
      setConfirmingReset(true)
      return
    }
    const store = clientSettings()
    for (const key of clientSettingsTable.keys) store?.reset(key)
    setConfirmingReset(false)
  }

  const jumpTo = (id: string): void => {
    scrollRef.current?.querySelector(`#${sectionDomId(id)}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setActiveIds(new Set([id]))
  }

  const navPages = shownPages.filter((p) => !searching || visible.has(p.id))

  const renderPage = (page: SettingsPage): JSX.Element => {
    const sectionMatched = query !== '' && page.title.toLowerCase().includes(query)
    const hidden = query !== '' && !visible.has(page.id)
    const Page = page.component
    return (
      <section key={page.id} id={sectionDomId(page.id)} data-section-id={page.id} hidden={hidden} className="scroll-mt-8">
        <h2 className="text-sm font-medium text-secondary mb-2 px-1">{page.title}</h2>
        <div className="rounded-xl border border-subtle bg-surface-1 px-3 py-2 overflow-hidden">
          <SettingsSearchContext.Provider value={{ query, sectionMatched }}>
            <Page workspaceId={workspaceId} />
          </SettingsSearchContext.Provider>
        </div>
      </section>
    )
  }

  const navigation = (
    <div className="min-h-0 flex-1 flex flex-col text-primary">
      <div className="shrink-0 px-2 pt-1 pb-1">
        <SearchField aria-label="Search settings" value={rawQuery} onValueChange={setRawQuery} placeholder="Search settings…"
          containerClassName="!h-7 !px-1 !border-transparent !bg-transparent hover:!bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)] focus-within:!bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]" />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {shownScopes.map((shown) => {
          const scoped = navPages.filter((p) => p.scope === shown)
          if (scoped.length === 0) return null
          const ScopeIcon = SCOPE_ICONS[shown]
          return (
            <div key={shown} className="[&:not(:first-child)]:mt-5">
              {workspaceId && (shown === 'workspace' && openEntries.length > 1 ? (
                <DropdownSelect
                  quiet
                  label="Project"
                  title={scopeDescription(shown)}
                  value={workspaceId}
                  onChange={setPicked}
                  options={openEntries.map((entry) => ({ value: entry.id, label: entry.name }))}
                  icon={<ScopeIcon size={13} className="shrink-0" />}
                  className="mb-1 flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-[13px] text-secondary transition-colors hover:bg-hover hover:text-primary"
                />
              ) : (
                <div title={scopeDescription(shown)} className="flex h-7 items-center gap-2 px-2 mb-1 text-[13px] text-muted">
                  <ScopeIcon size={13} className="shrink-0" />
                  <span className="truncate">{shown === 'client' ? 'Device' : workspace?.name ?? 'Workspace'}</span>
                </div>
              ))}
              {SETTINGS_GROUPS.map((group) => {
                const children = scoped.filter((p) => p.group === group.id)
                if (children.length === 0) return null
                const GroupIcon = GROUP_ICONS[group.id]
                // The group of the page in view opens; the rest collapse.
                const groupActive = children.some((p) => activeIds.has(p.id))
                return (
                  <div key={group.id} className="mb-0.5">
                    <button
                      type="button"
                      onClick={() => jumpTo(children[0].id)}
                      aria-current={groupActive ? 'true' : undefined}
                      className={`w-full h-[30px] px-2 flex items-center gap-2 rounded-md text-[13px] font-medium transition-colors ${
                        groupActive ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-hover hover:text-primary'
                      }`}
                    >
                      <GroupIcon size={15} />
                      {group.title}
                    </button>
                    {groupActive && (
                      <div className="ml-6 mt-0.5 mb-1 flex flex-col gap-0.5">
                        {children.map((page) => (
                          <button
                            type="button"
                            key={page.id}
                            onClick={() => jumpTo(page.id)}
                            aria-current={activeIds.has(page.id) ? 'page' : undefined}
                            className={`text-left px-2 py-1 rounded-md text-xs transition-colors ${
                              activeIds.has(page.id) ? 'text-primary' : 'text-muted hover:text-secondary'
                            }`}
                          >
                            {page.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
        {navPages.length === 0 && <span className="block px-3 py-2 text-xs text-muted">No matches</span>}
      </nav>
      <div className="shrink-0 flex items-center gap-1 p-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 h-8 px-2 flex items-center gap-2 rounded-md text-[13px] text-secondary hover:bg-hover hover:text-primary transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <UpdateButton />
      </div>
    </div>
  )

  const content = (
    <main className="relative h-full min-w-0 flex-1 flex flex-col bg-canvas-bg text-primary pointer-events-auto">
      <LeftSidebarReopen />
      <OverlayHeader title="Settings">
        {desktop && (
          <button
            onClick={() => void openSettingsFile()}
            title="Open this device's settings.json"
            className="flex items-center gap-1.5 px-2 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs"
          >
            <BracketsCurly size={14} />
            Open settings.json
          </button>
        )}
        <button
          type="button"
          onClick={restoreDefaults}
          title="Restore this device's settings to their defaults (workspace settings stay)"
          aria-label={confirmingReset ? 'Confirm restore' : 'Restore defaults'}
          className={`flex items-center justify-center gap-1.5 h-7 rounded-md text-secondary hover:bg-hover hover:text-primary text-xs ${confirmingReset ? 'px-2' : 'w-7'}`}
        >
          <RotateCcw size={14} />
          {confirmingReset && 'Confirm restore'}
        </button>
      </OverlayHeader>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        <div className="w-full max-w-[860px] mx-auto flex flex-col gap-16 pb-12">
          {shownScopes.map((shown) => {
            const scoped = shownPages.filter((p) => p.scope === shown)
            if (scoped.length === 0) return null
            const hidden = searching && !scoped.some((p) => visible.has(p.id))
            return (
              <div key={shown} data-scope={shown} hidden={hidden} className="flex flex-col gap-7">
                <header className="px-1 border-b border-subtle pb-3">
                  <h1 className="text-base font-semibold text-primary truncate">{scopeTitle(shown)}</h1>
                  <p className="text-xs text-muted mt-0.5">{scopeDescription(shown)}</p>
                </header>
                {scoped.map(renderPage)}
              </div>
            )
          })}
          {query !== '' && visible.size === 0 && (
            <div className="py-10 text-center text-sm text-muted">No settings match “{rawQuery.trim()}”.</div>
          )}
        </div>
      </div>
    </main>
  )

  if (slots) return <>{createPortal(navigation, slots.sidebar)}{createPortal(content, slots.content)}</>
  return createPortal(
    <div className="fixed inset-0 flex bg-surface-1 text-primary" style={{ zIndex: dialogOrder }}>
      <aside className="w-[220px] shrink-0 flex flex-col pt-3">{navigation}</aside>
      {content}
    </div>,
    document.body,
  )
}
